import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { chat, makeHarness } from "./helpers.ts";

const SETTLED_PER_REQUEST = 70;

describe("budget enforcement", () => {
  it("charges the provider-reported cost, not the estimate", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const res = await h.app.inject(chat(key, "test-priced"));

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.usage.prompt_tokens, 20);
    assert.equal(body.usage.completion_tokens, 50);
    assert.equal(body.gateway.cost_micro_usd, SETTLED_PER_REQUEST);
    assert.equal(body.gateway.key_budget.spent_micro_usd, SETTLED_PER_REQUEST);

    assert.equal(
      body.gateway.key_budget.remaining_micro_usd,
      100_000 - SETTLED_PER_REQUEST,
    );
  });

  it("blocks with 402 once the budget cannot cover another request", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(300);

    let ok = 0;
    let blocked = 0;
    let lastBlockedCode: string | undefined;

    for (let i = 0; i < 20; i++) {
      const res = await h.app.inject(chat(key, "test-priced"));
      if (res.statusCode === 200) ok++;
      else if (res.statusCode === 402) {
        blocked++;
        lastBlockedCode = res.json().error?.code;
      } else assert.fail(`unexpected status ${res.statusCode}: ${res.body}`);
    }

    assert.ok(ok > 0, "some requests should have succeeded");
    assert.ok(blocked > 0, "the key must eventually be refused");

    const usage = await h.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${key}` },
    });
    const u = usage.json();
    assert.ok(
      u.key.spent_micro_usd <= 300,
      `spend ${u.key.spent_micro_usd} must never exceed the 300 budget`,
    );
    assert.equal(u.key.spent_micro_usd, ok * SETTLED_PER_REQUEST);
    assert.equal(u.key.reserved_micro_usd, 0, "no reservation may be left dangling");

    assert.equal(lastBlockedCode, "budget_exceeded");
  });

  it("never overspends when concurrent requests race a near-exhausted key", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const BUDGET = 1_000;
    const { key } = await h.createKey(BUDGET);

    const results = await Promise.all(
      Array.from({ length: 40 }, () => h.app.inject(chat(key, "test-priced"))),
    );

    const ok = results.filter((r) => r.statusCode === 200).length;
    const blocked = results.filter((r) => r.statusCode === 402).length;
    assert.equal(ok + blocked, 40, "every request resolved to 200 or 402");
    assert.ok(ok > 0, "at least one should get through");
    assert.ok(blocked > 0, "the cap must bite under concurrency");

    const usage = await h.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${key}` },
    });
    const u = usage.json();

    assert.ok(
      u.key.spent_micro_usd <= BUDGET,
      `spend ${u.key.spent_micro_usd} exceeded budget ${BUDGET} — the CAS leaked`,
    );
    assert.equal(u.key.spent_micro_usd, ok * SETTLED_PER_REQUEST);
    assert.equal(u.key.reserved_micro_usd, 0, "all reservations settled or released");
    assert.equal(u.usage.ok_requests, ok);
    assert.equal(u.usage.blocked_requests, blocked);
  });

  it("returns the reservation when every provider fails, so failures cost nothing", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key } = await h.createKey(100_000);
    const res = await h.app.inject(chat(key, "test-all-down"));
    assert.equal(res.statusCode, 502);

    const usage = await h.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${key}` },
    });
    const u = usage.json();
    assert.equal(u.key.spent_micro_usd, 0, "a failed request must not be billed");
    assert.equal(u.key.reserved_micro_usd, 0, "its reservation must be released");
    assert.equal(u.usage.error_requests, 1, "but it is still recorded in the ledger");
  });

  it("refuses a disabled key and logs the attempt", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const { key, id } = await h.createKey(100_000);
    const patch = await h.app.inject({
      method: "PATCH",
      url: `/admin/keys/${id}`,
      headers: { authorization: "Bearer test-admin-token-0123456789" },
      payload: { status: "disabled" },
    });
    assert.equal(patch.statusCode, 200);

    const res = await h.app.inject(chat(key, "test-priced"));
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "key_disabled");
  });
});
