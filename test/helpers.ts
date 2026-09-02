import { randomUUID } from "node:crypto";
import { generateVirtualKey } from "../src/auth.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { ProviderError } from "../src/errors.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { buildServer, type BuiltServer } from "../src/server.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import type { Provider, ProviderInvocation, ProviderResult } from "../src/types.ts";

export const ADMIN_TOKEN = "test-admin-token-0123456789";

export class StubProvider implements Provider {
  readonly name: string;
  calls = 0;
  constructor(
    name = "stub",
    private readonly inTok = 20,
    private readonly outTok = 50,
  ) {
    this.name = name;
  }
  isConfigured() {
    return true;
  }
  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    this.calls++;
    return {
      text: `stub reply to ${inv.messages.length} message(s)`,
      finishReason: "stop",
      inputTokens: this.inTok,
      outputTokens: this.outTok,
    };
  }
}

export class FailingProvider implements Provider {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly kind: "caller" | "target" | "retryable" = "retryable",
    private readonly status = 503,
  ) {}
  isConfigured() {
    return true;
  }
  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    this.calls++;
    throw new ProviderError(this.kind, this.name, inv.model, "synthetic failure", this.status);
  }
}

export class UnconfiguredProvider implements Provider {
  calls = 0;
  constructor(readonly name: string) {}
  isConfigured() {
    return false;
  }
  async invoke(): Promise<ProviderResult> {
    this.calls++;
    throw new Error("should never be invoked");
  }
}

export interface Harness extends BuiltServer {
  providers: {
    stub: StubProvider;
    boom: FailingProvider;
    boom2: FailingProvider;
    badreq: FailingProvider;
    nokey: UnconfiguredProvider;
  };
  createKey(budgetMicros: number, name?: string): Promise<{ key: string; id: string }>;
  close(): Promise<void>;
}

export async function makeHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const cfg: Config = {
    ...loadConfig({
      ADMIN_TOKEN,
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MODEL_CATALOG_PATH: "./test/fixtures/models.test.json",

      RETRY_BASE_DELAY_MS: "1",
      RETRY_MAX_DELAY_MS: "2",
      PROVIDER_TIMEOUT_MS: "2000",
      REQUEST_DEADLINE_MS: "8000",
      MAX_RETRIES_PER_TARGET: "0",
    }),
    ...overrides,
  };

  const providers = {
    stub: new StubProvider("stub"),
    boom: new FailingProvider("boom", "retryable", 503),
    boom2: new FailingProvider("boom2", "retryable", 500),
    badreq: new FailingProvider("badreq", "caller", 400),
    nokey: new UnconfiguredProvider("nokey"),
  };

  const registry: ProviderRegistry = new Map(
    Object.values(providers).map((p) => [p.name, p as Provider]),
  );

  const store = new SqliteStore(":memory:");
  const built = await buildServer(cfg, { store, registry, allowFaultInjection: true });
  await built.app.ready();

  return {
    ...built,
    providers,
    async createKey(budgetMicros: number, name = "test key") {
      const { key, prefix, hash } = generateVirtualKey();
      const rec = await store.createKey({
        id: `vk_${randomUUID()}`,
        name,
        key_prefix: prefix,
        key_hash: hash,
        budget_micros: budgetMicros,
        created_at: new Date().toISOString(),
      });
      return { key, id: rec.id };
    },
    async close() {
      await built.app.close();
      await store.close();
    },
  };
}

export function chat(key: string, model: string, content = "hello", extra: object = {}) {
  return {
    method: "POST" as const,
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: { model, messages: [{ role: "user", content }], ...extra },
  };
}
