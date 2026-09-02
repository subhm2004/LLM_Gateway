import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { CircuitBreaker } from "../src/breaker.ts";
import { chat, makeHarness } from "./helpers.ts";

describe("fallback policy", () => {
  it("walks past failing targets and serves from the next healthy one", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const res = await h.app.inject(chat(key, "test-fallback"));

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.gateway.served_provider, "stub");
    assert.equal(body.gateway.fallback_used, true);
    assert.equal(res.headers["x-gateway-fallback"], "true");
    assert.equal(h.providers.boom.calls, 1);
    assert.equal(h.providers.boom2.calls, 1);
    assert.equal(h.providers.stub.calls, 1);

    assert.equal(body.gateway.cost_micro_usd, 70);
  });

  it("fails fast on a caller error instead of retrying the whole chain", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const res = await h.app.inject(chat(key, "test-caller-error"));

    assert.equal(res.statusCode, 400);
    assert.equal(h.providers.badreq.calls, 1, "the bad target was tried once");
    assert.equal(
      h.providers.stub.calls,
      0,
      "a malformed request must NOT be replayed against the next provider",
    );
  });

  it("skips a provider with no credential without spending an attempt on it", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const res = await h.app.inject(chat(key, "test-unconfigured"));

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().gateway.served_provider, "stub");
    assert.equal(h.providers.nokey.calls, 0, "unconfigured providers are never invoked");
  });

  it("returns 502 with the attempt trace when the whole chain is down", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const res = await h.app.inject(chat(key, "test-all-down"));

    assert.equal(res.statusCode, 502);
    const body = res.json();
    assert.equal(body.error.code, "all_providers_failed");
    assert.ok(Array.isArray(body.error.details.attempts));
    assert.equal(body.error.details.attempts[0].provider, "boom");
  });

  it("honours injected faults so fallback is demonstrable on a live URL", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const req = chat(key, "test-priced");
    const res = await h.app.inject({
      ...req,
      headers: { ...req.headers, "x-gateway-fail-providers": "stub" },
    });

    assert.equal(res.statusCode, 502, "the only target was forced to fail");
  });
});

describe("circuit breaker", () => {
  it("opens after the threshold, then half-opens for a single probe", () => {
    let now = 0;
    const b = new CircuitBreaker(3, 1000, () => now);

    assert.equal(b.isOpen("p:m"), false);
    b.recordFailure("p:m");
    b.recordFailure("p:m");
    assert.equal(b.isOpen("p:m"), false, "still closed below the threshold");

    b.recordFailure("p:m");
    assert.equal(b.isOpen("p:m"), true, "third consecutive failure opens it");

    now += 999;
    assert.equal(b.isOpen("p:m"), true, "still open inside the cooldown");

    now += 2;
    assert.equal(b.isOpen("p:m"), false, "cooldown elapsed — one probe allowed");

    b.recordFailure("p:m");
    assert.equal(b.isOpen("p:m"), true);

    now += 1001;
    assert.equal(b.isOpen("p:m"), false);
    b.recordSuccess("p:m");
    assert.equal(b.isOpen("p:m"), false, "a successful probe closes it");
    assert.equal(b.snapshot()[0]?.state, "closed");
  });

  it("takes a dead target out of the chain after repeated failures", async () => {
    const h = await makeHarness({ BREAKER_FAILURE_THRESHOLD: 2 } as never);
    after(() => h.close());

    const { key } = await h.createKey(1_000_000);
    for (let i = 0; i < 4; i++) await h.app.inject(chat(key, "test-fallback"));

    assert.ok(
      h.providers.boom.calls < 4,
      `boom was attempted ${h.providers.boom.calls} times — breaker never opened`,
    );
    assert.equal(h.providers.stub.calls, 4, "requests still succeed via fallback");

    const stats = await h.app.inject({
      method: "GET",
      url: "/admin/stats",
      headers: { authorization: "Bearer test-admin-token-0123456789" },
    });
    const open = stats.json().circuit_breakers.filter((c: { state: string }) => c.state === "open");
    assert.ok(open.length > 0, "at least one breaker is open");
  });
});
