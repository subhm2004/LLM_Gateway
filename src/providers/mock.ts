import { ProviderError } from "../errors.ts";
import { estimateInputTokens } from "../tokens.ts";
import type { Provider, ProviderInvocation, ProviderResult } from "../types.ts";

export class MockProvider implements Provider {
  readonly name = "mock";

  isConfigured() {
    return true;
  }

  async listModels(): Promise<string[]> {
    return ["mock-echo"];
  }

  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    if (inv.signal.aborted) {
      throw new ProviderError("retryable", this.name, inv.model, "Aborted before dispatch.", 408);
    }
    const lastUser = [...inv.messages].reverse().find((m) => m.role === "user");

    const text =
      `[mock-echo] Deterministic local stub served by the gateway — not a real ` +
      `model completion. Last user message was ${lastUser?.content.length ?? 0} ` +
      `characters across ${inv.messages.length} message(s).`;

    return {
      text,
      finishReason: "stop",
      inputTokens: estimateInputTokens(inv.messages),
      outputTokens: Math.ceil(text.length / 4),
      providerRequestId: "mock-local",
    };
  }
}

export class FaultInjector {
  constructor(private readonly enabled: boolean) {}

  get isEnabled() {
    return this.enabled;
  }

  parse(headerValue: unknown): Set<string> {
    if (!this.enabled || typeof headerValue !== "string") return new Set();
    return new Set(
      headerValue
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  wrap(provider: Provider, failing: Set<string>): Provider {
    if (!failing.has(provider.name)) return provider;
    return {
      name: provider.name,
      isConfigured: () => provider.isConfigured(),
      invoke: async (inv) => {
        throw new ProviderError(
          "retryable",
          provider.name,
          inv.model,
          "Synthetic failure injected via x-gateway-fail-providers.",
          503,
        );
      },
    };
  }
}
