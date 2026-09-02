import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiKeyRecord, UsageEvent } from "../types.ts";
import type {
  ModelBreakdownRow,
  NewKey,
  ReserveResult,
  SettleArgs,
  Store,
  UsageSummary,
} from "./index.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_prefix      TEXT NOT NULL UNIQUE,
  key_hash        TEXT NOT NULL,
  budget_micros   INTEGER NOT NULL,
  spent_micros    INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id            TEXT PRIMARY KEY,
  key_id        TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
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
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_micros     INTEGER NOT NULL DEFAULT 0,
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

export class SqliteStore implements Store {
  readonly dialect = "sqlite" as const;
  private db!: DatabaseSync;

  constructor(private readonly path: string) {}

  async init() {
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);

    this.db.exec("PRAGMA journal_mode = WAL");

    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(DDL);
  }

  async close() {
    this.db?.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw e;
    }
  }

  async createKey(k: NewKey): Promise<ApiKeyRecord> {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_prefix, key_hash, budget_micros, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(k.id, k.name, k.key_prefix, k.key_hash, k.budget_micros, k.created_at);
    return (await this.getKey(k.id))!;
  }

  async findKeyByPrefix(prefix: string) {
    const row = this.db
      .prepare(`SELECT ${KEY_COLS}, key_hash FROM api_keys WHERE key_prefix = ?`)
      .get(prefix);
    return (row ?? null) as (ApiKeyRecord & { key_hash: string }) | null;
  }

  async getKey(id: string) {
    const row = this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`).get(id);
    return (row ?? null) as ApiKeyRecord | null;
  }

  async listKeys() {
    return this.db
      .prepare(`SELECT ${KEY_COLS} FROM api_keys ORDER BY created_at DESC`)
      .all() as unknown as ApiKeyRecord[];
  }

  async updateKey(
    id: string,
    patch: { budget_micros?: number; status?: "active" | "disabled"; name?: string },
  ) {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.budget_micros !== undefined) {
      sets.push("budget_micros = ?");
      vals.push(patch.budget_micros);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      vals.push(patch.status);
    }
    if (patch.name !== undefined) {
      sets.push("name = ?");
      vals.push(patch.name);
    }
    if (!sets.length) return this.getKey(id);
    vals.push(id);
    this.db.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    return this.getKey(id);
  }

  async reserve(
    keyId: string,
    amountMicros: number,
    reservationId: string,
    nowIso: string,
    expiresAtIso: string,
  ): Promise<ReserveResult> {
    return this.tx(() => {
      const rows = this.db
        .prepare(
          `UPDATE api_keys
              SET reserved_micros = reserved_micros + ?
            WHERE id = ?
              AND status = 'active'
              AND spent_micros + reserved_micros + ? <= budget_micros
          RETURNING ${KEY_COLS}`,
        )
        .all(amountMicros, keyId, amountMicros) as unknown as ApiKeyRecord[];

      const updated = rows[0];
      if (!updated) {
        const key = (this.db
          .prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`)
          .get(keyId) ?? null) as ApiKeyRecord | null;
        if (!key) return { ok: false as const, reason: "not_found" as const, key: null };
        if (key.status !== "active")
          return { ok: false as const, reason: "disabled" as const, key };
        return { ok: false as const, reason: "insufficient_budget" as const, key };
      }

      this.db
        .prepare(
          `INSERT INTO reservations (id, key_id, amount_micros, state, created_at, expires_at)
           VALUES (?, ?, ?, 'open', ?, ?)`,
        )
        .run(reservationId, keyId, amountMicros, nowIso, expiresAtIso);

      return { ok: true as const, key: updated };
    });
  }

  async settle(a: SettleArgs): Promise<ApiKeyRecord | null> {
    return this.tx(() => {
      const claimed = this.db
        .prepare(`UPDATE reservations SET state = 'settled' WHERE id = ? AND state = 'open'
                  RETURNING amount_micros`)
        .all(a.reservationId) as unknown as { amount_micros: number }[];

      const releaseMicros = claimed[0] ? a.reservedMicros : 0;

      const updated = this.db
        .prepare(
          `UPDATE api_keys
              SET reserved_micros = MAX(reserved_micros - ?, 0),
                  spent_micros    = spent_micros + ?
            WHERE id = ?
          RETURNING ${KEY_COLS}`,
        )
        .all(releaseMicros, a.actualMicros, a.keyId) as unknown as ApiKeyRecord[];

      this.insertEvent(a.event);
      return updated[0] ?? null;
    });
  }

  async recordEvent(event: Omit<UsageEvent, "id">) {
    this.tx(() => this.insertEvent(event));
  }

  private insertEvent(e: Omit<UsageEvent, "id">) {
    this.db
      .prepare(
        `INSERT INTO usage_events
          (id, request_id, key_id, requested_model, served_provider, served_model,
           input_tokens, output_tokens, cost_micros, status, http_status, error_code,
           cache_hit, fallback_used, attempts, latency_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        e.request_id,
        e.key_id,
        e.requested_model,
        e.served_provider,
        e.served_model,
        e.input_tokens,
        e.output_tokens,
        e.cost_micros,
        e.status,
        e.http_status,
        e.error_code,
        e.cache_hit,
        e.fallback_used,
        e.attempts,
        e.latency_ms,
        e.created_at,
      );
  }

  async sweepExpiredReservations(nowIso: string) {
    return this.tx(() => {
      const stale = this.db
        .prepare(
          `UPDATE reservations SET state = 'expired'
            WHERE state = 'open' AND expires_at < ?
          RETURNING key_id, amount_micros`,
        )
        .all(nowIso) as unknown as { key_id: string; amount_micros: number }[];

      const dec = this.db.prepare(
        `UPDATE api_keys SET reserved_micros = MAX(reserved_micros - ?, 0) WHERE id = ?`,
      );
      for (const r of stale) dec.run(r.amount_micros, r.key_id);
      return stale.length;
    });
  }

  async usageSummary(keyId: string, sinceIso?: string): Promise<UsageSummary> {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*)                                              AS requests,
           COALESCE(SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END),0)      AS ok_requests,
           COALESCE(SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END),0) AS blocked_requests,
           COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0)   AS error_requests,
           COALESCE(SUM(input_tokens),0)                         AS input_tokens,
           COALESCE(SUM(output_tokens),0)                        AS output_tokens,
           COALESCE(SUM(cost_micros),0)                          AS cost_micros,
           COALESCE(SUM(cache_hit),0)                            AS cache_hits,
           MIN(created_at)                                       AS first_request_at,
           MAX(created_at)                                       AS last_request_at
         FROM usage_events
         WHERE key_id = ? AND (? IS NULL OR created_at >= ?)`,
      )
      .get(keyId, sinceIso ?? null, sinceIso ?? null) as Record<string, number | string | null>;
    return { key_id: keyId, ...row } as unknown as UsageSummary;
  }

  async modelBreakdown(keyId: string, sinceIso?: string): Promise<ModelBreakdownRow[]> {
    return this.db
      .prepare(
        `SELECT served_provider, served_model,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens),0)  AS input_tokens,
                COALESCE(SUM(output_tokens),0) AS output_tokens,
                COALESCE(SUM(cost_micros),0)   AS cost_micros
           FROM usage_events
          WHERE key_id = ? AND status = 'ok' AND (? IS NULL OR created_at >= ?)
          GROUP BY served_provider, served_model
          ORDER BY cost_micros DESC`,
      )
      .all(keyId, sinceIso ?? null, sinceIso ?? null) as unknown as ModelBreakdownRow[];
  }

  async recentEvents(keyId: string, limit: number) {
    return this.db
      .prepare(
        `SELECT * FROM usage_events WHERE key_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(keyId, limit) as unknown as UsageEvent[];
  }
}
