import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { generateVirtualKey, hashKey, hashesMatch } from "../src/auth.ts";
import { ADMIN_TOKEN, chat, makeHarness } from "./helpers.ts";

describe("virtual keys", () => {
  it("generates high-entropy keys whose plaintext is never stored", async () => {
    const a = generateVirtualKey();
    const b = generateVirtualKey();

    assert.ok(a.key.startsWith("sk-gw-"));
    assert.notEqual(a.key, b.key);
    assert.equal(a.prefix, a.key.slice(0, 14));
    assert.equal(a.hash, hashKey(a.key));
    assert.notEqual(a.hash, a.key);
    assert.ok(hashesMatch(a.hash, hashKey(a.key)));
    assert.ok(!hashesMatch(a.hash, hashKey(b.key)));
  });

  it("rejects missing, malformed and unknown keys with 401", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const noKey = await h.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "test-priced", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(noKey.statusCode, 401);

    assert.equal((await h.app.inject(chat("not-a-key", "test-priced"))).statusCode, 401);
    assert.equal(
      (await h.app.inject(chat(`sk-gw-${"x".repeat(43)}`, "test-priced"))).statusCode,
      401,
    );
    assert.equal(h.providers.stub.calls, 0, "no provider call on a rejected key");
  });

  it("never returns a provider credential or a key hash to the caller", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const created = await h.app.inject({
      method: "POST",
      url: "/admin/keys",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: "leak check", budget_usd: 1 },
    });
    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.ok(body.key.startsWith("sk-gw-"), "plaintext returned exactly once, at creation");
    assert.equal(body.key_hash, undefined, "the hash is never exposed");

    const listed = await h.app.inject({
      method: "GET",
      url: "/admin/keys",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const raw = listed.body;
    assert.ok(!raw.includes("key_hash"), "list must not include hashes");
    assert.ok(!raw.includes(body.key), "list must not include plaintext keys");
  });
});

describe("admin authorization", () => {
  it("refuses every /admin route without the admin token", async () => {
    const h = await makeHarness();
    after(() => h.close());

    for (const url of ["/admin/keys", "/admin/stats", "/admin/usage?key_id=x"]) {
      const res = await h.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 403, `${url} must be gated`);
    }
    const wrong = await h.app.inject({
      method: "GET",
      url: "/admin/keys",
      headers: { authorization: "Bearer wrong-token-of-same-len-000" },
    });
    assert.equal(wrong.statusCode, 403);
  });

  it("does not let a virtual key act as an admin token", async () => {
    const h = await makeHarness();
    after(() => h.close());
    const { key } = await h.createKey(1000);

    const res = await h.app.inject({
      method: "GET",
      url: "/admin/keys",
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(res.statusCode, 403);
  });

  it("scopes /v1/usage to the calling key only", async () => {
    const h = await makeHarness();
    after(() => h.close());

    const a = await h.createKey(100_000, "key A");
    const b = await h.createKey(100_000, "key B");
    await h.app.inject(chat(a.key, "test-priced"));

    const asB = await h.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${b.key}` },
    });
    assert.equal(asB.json().key.id, b.id, "B sees only B");
    assert.equal(asB.json().usage.requests, 0);

    const asA = await h.app.inject({
      method: "GET",
      url: "/v1/usage",
      headers: { authorization: `Bearer ${a.key}` },
    });
    assert.equal(asA.json().usage.requests, 1);
  });
});
