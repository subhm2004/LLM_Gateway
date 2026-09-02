import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { generateVirtualKey } from "../src/auth.ts";
import { PostgresStore } from "../src/store/postgres.ts";

const DATABASE_URL = process.env.DATABASE_URL;

describe(
  "postgres store: the budget CAS under real row-level contention",
  { skip: DATABASE_URL ? false : "DATABASE_URL not set — run with a real Postgres to exercise this" },
  () => {
    let store: PostgresStore;
    const suffix = randomUUID().slice(0, 8);

    before(async () => {
      store = new PostgresStore(DATABASE_URL!);
      await store.init();
    });

    after(async () => {
      await store?.close();
    });

    async function makeKey(budgetMicros: number) {
      const { prefix, hash } = generateVirtualKey();
      return store.createKey({
        id: `vk_test_${suffix}_${randomUUID()}`,
        name: `pg concurrency ${suffix}`,
        key_prefix: prefix,
        key_hash: hash,
        budget_micros: budgetMicros,
        created_at: new Date().toISOString(),
      });
    }

    it("admits exactly floor(budget/amount) of N simultaneous reservations", async () => {
      const AMOUNT = 100;
      const BUDGET = 1000;
      const ATTEMPTS = 60;
      const key = await makeKey(BUDGET);

      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: ATTEMPTS }, () =>
          store.reserve(
            key.id,
            AMOUNT,
            randomUUID(),
            now.toISOString(),
            new Date(now.getTime() + 60_000).toISOString(),
          ),
        ),
      );

      const granted = results.filter((r) => r.ok).length;
      const refused = results.filter((r) => !r.ok).length;

      assert.equal(granted + refused, ATTEMPTS);
      assert.equal(
        granted,
        BUDGET / AMOUNT,
        "the CAS must admit exactly the number the budget affords, no more",
      );

      const after = await store.getKey(key.id);
      assert.equal(after!.reserved_micros, BUDGET, "reserved is exactly the budget, never above");
      assert.ok(
        after!.spent_micros + after!.reserved_micros <= after!.budget_micros,
        "spent + reserved never exceeds budget",
      );
    });

    it("settles concurrently without losing or double-counting spend", async () => {
      const AMOUNT = 100;
      const ACTUAL = 60;
      const BUDGET = 1000;
      const key = await makeKey(BUDGET);
      const now = new Date();

      const reservations: (string | null)[] = await Promise.all(
        Array.from({ length: 30 }, () => {
          const rid: string = randomUUID();
          return store
            .reserve(key.id, AMOUNT, rid, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
            .then((r): string | null => (r.ok ? rid : null));
        }),
      );
      const granted = reservations.filter((r): r is string => r !== null);
      assert.equal(granted.length, BUDGET / AMOUNT);

      await Promise.all(
        granted.map((rid) =>
          store.settle({
            reservationId: rid,
            keyId: key.id,
            reservedMicros: AMOUNT,
            actualMicros: ACTUAL,
            event: {
              request_id: rid,
              key_id: key.id,
              requested_model: "test",
              served_provider: "stub",
              served_model: "stub-1",
              input_tokens: 10,
              output_tokens: 50,
              cost_micros: ACTUAL,
              status: "ok",
              http_status: 200,
              error_code: null,
              cache_hit: 0,
              fallback_used: 0,
              attempts: 1,
              latency_ms: 1,
              created_at: new Date().toISOString(),
            },
          }),
        ),
      );

      const after = await store.getKey(key.id);
      assert.equal(after!.spent_micros, granted.length * ACTUAL, "every settle counted exactly once");
      assert.equal(after!.reserved_micros, 0, "every reservation released");

      const summary = await store.usageSummary(key.id);
      assert.equal(summary.ok_requests, granted.length);
      assert.equal(summary.cost_micros, granted.length * ACTUAL);
    });

    it("returns orphaned reservations to the key", async () => {
      const key = await makeKey(1000);
      const past = new Date(Date.now() - 60_000).toISOString();
      await store.reserve(key.id, 400, randomUUID(), past, past);

      const before = await store.getKey(key.id);
      assert.equal(before!.reserved_micros, 400);

      const reclaimed = await store.sweepExpiredReservations(new Date().toISOString());
      assert.ok(reclaimed >= 1);

      const after = await store.getKey(key.id);
      assert.equal(after!.reserved_micros, 0, "the sweeper gave the headroom back");
    });

    it("refuses a disabled key regardless of headroom", async () => {
      const key = await makeKey(1_000_000);
      await store.updateKey(key.id, { status: "disabled" });
      const now = new Date();
      const r = await store.reserve(key.id, 1, randomUUID(), now.toISOString(), now.toISOString());
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, "disabled");
    });
  },
);
