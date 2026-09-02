import { createHash } from "node:crypto";
import type { ChatMessage, ProviderResult, Target } from "./types.ts";

interface Entry {
  value: { result: ProviderResult; target: Target };
  expiresAt: number;
}

export class ResponseCache {
  private map = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  static keyFor(input: {
    route: string;
    messages: ChatMessage[];
    maxTokens: number;
    temperature?: number | undefined;
    topP?: number | undefined;
    stop?: string[] | undefined;
  }) {
    const canonical = JSON.stringify([
      input.route,
      input.messages.map((m) => [m.role, m.content]),
      input.maxTokens,
      input.temperature ?? null,
      input.topP ?? null,
      input.stop ?? null,
    ]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  cacheable(temperature: number | undefined) {
    return this.enabled && temperature === 0;
  }

  get(key: string) {
    if (!this.enabled) return null;
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return null;
    }
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      this.misses++;
      return null;
    }

    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key: string, value: { result: ProviderResult; target: Target }) {
    if (!this.enabled) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      enabled: this.enabled,
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hit_rate: total ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }
}
