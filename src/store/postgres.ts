import pg from "pg";
import { randomUUID } from "node:crypto";
import type { ApiKeyRecord, UsageEvent } from "../types.ts";
import type {
  ModelBreakdownRow,
  NewKey,
  ReserveResult,
  SettleArgs,
  Store,
  UsageSummary,
} from "./index.ts";

pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_prefix      TEXT NOT NULL UNIQUE,
  key_hash        TEXT NOT NULL,
  budget_micros   BIGINT NOT NULL,
  spent_micros    BIGINT NOT NULL DEFAULT 0,
  reserved_micros BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id            TEXT PRIMARY KEY,
  key_id        TEXT NOT NULL,
  amount_micros BIGINT NOT NULL,
  state         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_res_open ON reservations(state, expires_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  served_provider TEXT,
  served_model    TEXT,
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  cost_micros     BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  http_status     INTEGER,
  error_code      TEXT,
  cache_hit       INTEGER NOT NULL DEFAULT 0,
  fallback_used   INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage_events(key_id, created_at);
`;

const KEY_COLS =
  "id, name, key_prefix, budget_micros, spent_micros, reserved_micros, status, created_at";

export class PostgresStore implements Store {
  readonly dialect = "postgres" as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,

      ssl: /sslmode=(require|prefer)/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
    });
  }

  async init() {
    await this.pool.query(DDL);
  }

  async close() {
    await this.pool.end();
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await c.query("ROLLBACK");
      } catch {
      }
      throw e;
    } finally {
      c.release();
    }
  }

  async createKey(k: NewKey): Promise<ApiKeyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys (id, name, key_prefix, key_hash, budget_micros, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${KEY_COLS}`,
      [k.id, k.name, k.key_prefix, k.key_hash, k.budget_micros, k.created_at],
    );
    return rows[0] as ApiKeyRecord;
  }

  async findKeyByPrefix(prefix: string) {
    const { rows } = await this.pool.query(
      `SELECT ${KEY_COLS}, key_hash FROM api_keys WHERE key_prefix = $1`,
      [prefix],
    );
    return (rows[0] ?? null) as (ApiKeyRecord & { key_hash: string }) | null;
  }

  async getKey(id: string) {
    const { rows } = await this.pool.query(
      `SELECT ${KEY_COLS} FROM api_keys WHERE id = $1`,
      [id],
    );
    return (rows[0] ?? null) as ApiKeyRecord | null;
  }

  async listKeys() {
    const { rows } = await this.pool.query(
      `SELECT ${KEY_COLS} FROM api_keys ORDER BY created_at DESC`,
    );
    return rows as ApiKeyRecord[];
  }

  async updateKey(
    id: string,
    patch: { budget_micros?: number; status?: "active" | "disabled"; name?: string },
  ) {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    let i = 1;
    if (patch.budget_micros !== undefined) {
      sets.push(`budget_micros = $${i++}`);
      vals.push(patch.budget_micros);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      vals.push(patch.status);
    }
    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      vals.push(patch.name);
    }
    if (!sets.length) return this.getKey(id);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE api_keys SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${KEY_COLS}`,
      vals,
    );
    return (rows[0] ?? null) as ApiKeyRecord | null;
  }

  async reserve(
    keyId: string,
    amountMicros: number,
    reservationId: string,
    nowIso: string,
    expiresAtIso: string,
  ): Promise<ReserveResult> {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE api_keys
            SET reserved_micros = reserved_micros + $1
          WHERE id = $2
            AND status = 'active'
            AND spent_micros + reserved_micros + $1 <= budget_micros
        RETURNING ${KEY_COLS}`,
        [amountMicros, keyId],
      );

      const updated = rows[0] as ApiKeyRecord | undefined;
      if (!updated) {
        const { rows: kr } = await c.query(
          `SELECT ${KEY_COLS} FROM api_keys WHERE id = $1`,
          [keyId],
        );
        const key = (kr[0] ?? null) as ApiKeyRecord | null;
        if (!key) return { ok: false as const, reason: "not_found" as const, key: null };
        if (key.status !== "active")
          return { ok: false as const, reason: "disabled" as const, key };
        return { ok: false as const, reason: "insufficient_budget" as const, key };
      }

      await c.query(
        `INSERT INTO reservations (id, key_id, amount_micros, state, created_at, expires_at)
         VALUES ($1,$2,$3,'open',$4,$5)`,
        [reservationId, keyId, amountMicros, nowIso, expiresAtIso],
      );
      return { ok: true as const, key: updated };
    });
  }

  async settle(a: SettleArgs): Promise<ApiKeyRecord | null> {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE reservations SET state = 'settled'
          WHERE id = $1 AND state = 'open' RETURNING amount_micros`,
        [a.reservationId],
      );
      const releaseMicros = rows[0] ? a.reservedMicros : 0;

      const { rows: kr } = await c.query(
        `UPDATE api_keys
            SET reserved_micros = GREATEST(reserved_micros - $1, 0),
                spent_micros    = spent_micros + $2
          WHERE id = $3
        RETURNING ${KEY_COLS}`,
        [releaseMicros, a.actualMicros, a.keyId],
      );
      await insertEvent(c, a.event);
      return (kr[0] ?? null) as ApiKeyRecord | null;
    });
  }

  async recordEvent(event: Omit<UsageEvent, "id">) {
    await insertEvent(this.pool, event);
  }

  async sweepExpiredReservations(nowIso: string) {
    return this.tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE reservations SET state = 'expired'
          WHERE state = 'open' AND expires_at < $1
        RETURNING key_id, amount_micros`,
        [nowIso],
      );
      for (const r of rows) {
        await c.query(
          `UPDATE api_keys SET reserved_micros = GREATEST(reserved_micros - $1, 0)
            WHERE id = $2`,
          [r.amount_micros, r.key_id],
        );
      }
      return rows.length;
    });
  }

  async usageSummary(keyId: string, sinceIso?: string): Promise<UsageSummary> {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*)                                                       AS requests,
         COALESCE(SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END),0)       AS ok_requests,
         COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END),0)  AS blocked_requests,
         COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0)    AS error_requests,
         COALESCE(SUM(input_tokens),0)  AS input_tokens,
         COALESCE(SUM(output_tokens),0) AS output_tokens,
         COALESCE(SUM(cost_micros),0)   AS cost_micros,
         COALESCE(SUM(cache_hit),0)     AS cache_hits,
         MIN(created_at) AS first_request_at,
         MAX(created_at) AS last_request_at
       FROM usage_events
       WHERE key_id = $1 AND ($2::text IS NULL OR created_at >= $2::text)`,
      [keyId, sinceIso ?? null],
    );
    return { key_id: keyId, ...rows[0] } as UsageSummary;
  }

  async modelBreakdown(keyId: string, sinceIso?: string): Promise<ModelBreakdownRow[]> {
    const { rows } = await this.pool.query(
      `SELECT served_provider, served_model,
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens),0)  AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(cost_micros),0)   AS cost_micros
         FROM usage_events
        WHERE key_id = $1 AND status = 'ok' AND ($2::text IS NULL OR created_at >= $2::text)
        GROUP BY served_provider, served_model
        ORDER BY cost_micros DESC`,
      [keyId, sinceIso ?? null],
    );
    return rows as ModelBreakdownRow[];
  }

  async recentEvents(keyId: string, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT * FROM usage_events WHERE key_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [keyId, limit],
    );
    return rows as UsageEvent[];
  }
}

async function insertEvent(
  q: { query: (t: string, v: unknown[]) => Promise<unknown> },
  e: Omit<UsageEvent, "id">,
) {
  await q.query(
    `INSERT INTO usage_events
      (id, request_id, key_id, requested_model, served_provider, served_model,
       input_tokens, output_tokens, cost_micros, status, http_status, error_code,
       cache_hit, fallback_used, attempts, latency_ms, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      randomUUID(), e.request_id, e.key_id, e.requested_model, e.served_provider,
      e.served_model, e.input_tokens, e.output_tokens, e.cost_micros, e.status,
      e.http_status, e.error_code, e.cache_hit, e.fallback_used, e.attempts,
      e.latency_ms, e.created_at,
    ],
  );
}
