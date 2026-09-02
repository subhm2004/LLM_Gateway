import type { ApiKeyRecord, UsageEvent } from "../types.ts";

export interface NewKey {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  budget_micros: number;
  created_at: string;
}

export type ReserveResult =
  | { ok: true; key: ApiKeyRecord }
  | {
      ok: false;
      reason: "not_found" | "disabled" | "insufficient_budget";
      key: ApiKeyRecord | null;
    };

export interface SettleArgs {
  reservationId: string;
  keyId: string;
  reservedMicros: number;
  actualMicros: number;
  event: Omit<UsageEvent, "id">;
}

export interface UsageSummary {
  key_id: string;
  requests: number;
  ok_requests: number;
  blocked_requests: number;
  error_requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  cache_hits: number;
  first_request_at: string | null;
  last_request_at: string | null;
}

export interface ModelBreakdownRow {
  served_model: string | null;
  served_provider: string | null;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

export interface Store {
  readonly dialect: "sqlite" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;

  createKey(k: NewKey): Promise<ApiKeyRecord>;
  findKeyByPrefix(prefix: string): Promise<(ApiKeyRecord & { key_hash: string }) | null>;
  getKey(id: string): Promise<ApiKeyRecord | null>;
  listKeys(): Promise<ApiKeyRecord[]>;
  updateKey(
    id: string,
    patch: { budget_micros?: number; status?: "active" | "disabled"; name?: string },
  ): Promise<ApiKeyRecord | null>;

  reserve(
    keyId: string,
    amountMicros: number,
    reservationId: string,
    nowIso: string,
    expiresAtIso: string,
  ): Promise<ReserveResult>;

  settle(args: SettleArgs): Promise<ApiKeyRecord | null>;

  recordEvent(event: Omit<UsageEvent, "id">): Promise<void>;

  sweepExpiredReservations(nowIso: string): Promise<number>;

  usageSummary(keyId: string, sinceIso?: string): Promise<UsageSummary>;
  modelBreakdown(keyId: string, sinceIso?: string): Promise<ModelBreakdownRow[]>;
  recentEvents(keyId: string, limit: number): Promise<UsageEvent[]>;
}

export async function createStore(opts: {
  databaseUrl?: string | undefined;
  sqlitePath: string;
}): Promise<Store> {
  if (opts.databaseUrl) {
    const { PostgresStore } = await import("./postgres.ts");
    return new PostgresStore(opts.databaseUrl);
  }
  const { SqliteStore } = await import("./sqlite.ts");
  return new SqliteStore(opts.sqlitePath);
}
