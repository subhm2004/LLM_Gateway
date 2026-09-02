import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ResponseCache } from "../src/cache.ts";
import { estimateInputTokens } from "../src/tokens.ts";
import { costMicros, microsToUsd, usdToMicros } from "../src/pricing.ts";
import { ADMIN_TOKEN, chat, makeHarness } from "./helpers.ts";
import type { Target } from "../src/types.ts";

describe("request validation", () => {
  it("rejects streaming with an explanation rather than hanging the client", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const { key } = await h.createKey(100_000);

    const res = await h.app.inject(chat(key, "test-priced", "hi", { stream: true }));
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /non-streaming/i);
  });

  it("404s an unknown model and lists what is available", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const { key } = await h.createKey(100_000);

    const res = await h.app.inject(chat(key, "gpt-9-ultra"));
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "model_not_found");
    assert.ok(res.json().error.details.available_models.includes("test-priced"));
  });

  it("rejects a request that cannot fit every model in the chain", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const { key } = await h.createKey(10_000_000);

    const res = await h.app.inject(chat(key, "test-priced", "x".repeat(40_000)));
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /context window/i);
    assert.equal(h.providers.stub.calls, 0, "caught before any provider call");
  });

  it("accepts OpenAI's array-of-parts content form", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const { key } = await h.createKey(100_000);

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      payload: {
        model: "test-priced",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe("usage ledger", () => {
  it("answers 'how much has key X spent' with a per-model breakdown", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const { key, id } = await h.createKey(100_000);

    await h.app.inject(chat(key, "test-priced"));
    await h.app.inject(chat(key, "test-priced"));
    await h.app.inject(chat(key, "test-fallback"));

    const res = await h.app.inject({
      method: "GET",
      url: `/admin/usage?key_id=${id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = res.json();

    assert.equal(body.usage.requests, 3);
    assert.equal(body.usage.ok_requests, 3);
    assert.equal(body.usage.cost_micros, 210);
    assert.equal(body.usage.cost_usd, 0.00021);
    assert.equal(body.usage.input_tokens, 60);
    assert.equal(body.usage.output_tokens, 150);
    assert.equal(body.by_model.length, 1, "all three were served by stub-1");
    assert.equal(body.by_model[0].served_model, "stub-1");
    assert.equal(body.recent_events.length, 3);
    assert.equal(body.key.spent_micro_usd, 210);
  });

  it("records blocked requests so refusals are auditable", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key, id } = await h.createKey(150);

    await h.app.inject(chat(key, "test-priced"));
    await h.app.inject(chat(key, "test-priced"));

    const res = await h.app.inject({
      method: "GET",
      url: `/admin/usage?key_id=${id}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = res.json();
    assert.equal(body.usage.ok_requests, 1);
    assert.equal(body.usage.blocked_requests, 1);
    const blocked = body.recent_events.find((e: { status: string }) => e.status === "blocked");
    assert.equal(blocked.error_code, "budget_exceeded");
    assert.equal(blocked.cost_micros, 0);
  });
});

describe("cost arithmetic", () => {
  it("keeps money as integers end to end", () => {
    assert.equal(usdToMicros(0.25), 250_000);
    assert.equal(microsToUsd(250_000), 0.25);

    assert.equal(usdToMicros(0.1) + usdToMicros(0.2), 300_000);
  });

  it("prices tokens against the target that actually served", () => {
    const t: Target = {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      input_usd_per_mtok: 0.59,
      output_usd_per_mtok: 0.79,
      context_window: 131072,
      default_max_tokens: 1024,
    };

    assert.equal(costMicros(t, 1000, 500), 985);
    assert.equal(costMicros(t, 0, 0), 0);
  });

  it("estimates input tokens generously, never under", () => {
    const est = estimateInputTokens([{ role: "user", content: "x".repeat(400) }]);
    assert.ok(est >= 100, "400 chars is at least 100 tokens");
    assert.ok(est > 100, "plus per-message overhead");
  });
});

describe("response cache", () => {
  it("only caches deterministic requests", () => {
    const c = new ResponseCache(true, 10, 60_000);
    assert.equal(c.cacheable(0), true);
    assert.equal(c.cacheable(0.7), false);
    assert.equal(c.cacheable(undefined), false);
    assert.equal(new ResponseCache(false, 10, 60_000).cacheable(0), false);
  });

  it("keys on the full request, so any change is a miss", () => {
    const base = { route: "r", messages: [{ role: "user" as const, content: "a" }], maxTokens: 10 };
    const k1 = ResponseCache.keyFor(base);
    assert.equal(k1, ResponseCache.keyFor({ ...base }));
    assert.notEqual(k1, ResponseCache.keyFor({ ...base, maxTokens: 11 }));
    assert.notEqual(k1, ResponseCache.keyFor({ ...base, route: "other" }));
    assert.notEqual(
      k1,
      ResponseCache.keyFor({ ...base, messages: [{ role: "user", content: "b" }] }),
    );
  });

  it("serves a repeat request from cache at zero cost", async () => {
    const h = await makeHarness({ CACHE_ENABLED: true } as never);
    after(() => h.close());
    const { key } = await h.createKey(100_000);

    const first = await h.app.inject(chat(key, "test-priced", "same", { temperature: 0 }));
    const second = await h.app.inject(chat(key, "test-priced", "same", { temperature: 0 }));

    assert.equal(first.headers["x-gateway-cache"], "miss");
    assert.equal(second.headers["x-gateway-cache"], "hit");
    assert.equal(h.providers.stub.calls, 1, "the provider was called only once");
    assert.equal(second.json().gateway.cost_micro_usd, 0, "a cache hit is free");
    assert.equal(second.json().gateway.key_budget.spent_micro_usd, 70, "spend did not grow");
  });
});

describe("service endpoints", () => {
  it("reports health without touching the datastore", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const res = await h.app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ok");
  });

  it("lists models with their fallback chains", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const res = await h.app.inject({ method: "GET", url: "/v1/models" });
    const body = res.json();
    assert.equal(body.object, "list");
    const route = body.data.find((m: { id: string }) => m.id === "test-fallback");
    assert.equal(route.gateway.fallback_chain.length, 3);
    assert.equal(route.gateway.fallback_chain[2].provider, "stub");
  });
});
