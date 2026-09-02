import { generateVirtualKey } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { usdToMicros } from "../src/pricing.ts";
import { createStore } from "../src/store/index.ts";
import { randomUUID } from "node:crypto";

function arg(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const cfg = loadConfig();
const store = await createStore({
  databaseUrl: cfg.DATABASE_URL,
  sqlitePath: cfg.SQLITE_PATH,
  insecureTls: cfg.DATABASE_SSL_INSECURE,
});
await store.init();

const name = arg("--name", "seed key");
const budgetUsd = Number(arg("--budget-usd", "0.25"));
const { key, prefix, hash } = generateVirtualKey();

const record = await store.createKey({
  id: `vk_${randomUUID()}`,
  name,
  key_prefix: prefix,
  key_hash: hash,
  budget_micros: usdToMicros(budgetUsd),
  created_at: new Date().toISOString(),
});

await store.close();

console.log("\nVirtual key created — this is the only time it is shown.\n");
console.log(`  key_id  : ${record.id}`);
console.log(`  name    : ${record.name}`);
console.log(`  budget  : $${budgetUsd.toFixed(6)} (${record.budget_micros} micro-USD)`);
console.log(`  store   : ${store.dialect}`);
console.log(`\n  ${key}\n`);
