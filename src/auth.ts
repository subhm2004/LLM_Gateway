import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { unauthorized } from "./errors.ts";
import type { Store } from "./store/index.ts";
import type { ApiKeyRecord } from "./types.ts";

export const KEY_PREFIX_LEN = 14;

export function generateVirtualKey() {
  const secret = randomBytes(32).toString("base64url");
  const key = `sk-gw-${secret}`;
  return { key, prefix: key.slice(0, KEY_PREFIX_LEN), hash: hashKey(key) };
}

export function hashKey(key: string) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function hashesMatch(a: string, b: string) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function extractBearer(headers: Record<string, unknown>): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const xk = headers["x-api-key"];
  if (typeof xk === "string" && xk.trim()) return xk.trim();
  return null;
}

export function adminTokenMatches(presented: string | null, expected: string) {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function authenticateKey(
  store: Pick<Store, "findKeyByPrefix">,
  headers: Record<string, unknown>,
): Promise<ApiKeyRecord> {
  const presented = extractBearer(headers);
  if (!presented || !presented.startsWith("sk-gw-")) throw unauthorized();

  const record = await store.findKeyByPrefix(presented.slice(0, KEY_PREFIX_LEN));
  const presentedHash = hashKey(presented);
  if (!record || !hashesMatch(presentedHash, record.key_hash)) throw unauthorized();

  const { key_hash: _discard, ...safe } = record;
  return safe;
}
