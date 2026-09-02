import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, classifyStatus } from "../errors.ts";
import type { ChatMessage, Provider, ProviderInvocation, ProviderResult } from "../types.ts";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic | null = null;

  constructor(apiKey: string | undefined, timeoutMs: number) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
    }
  }

  isConfigured() {
    return this.client !== null;
  }

  async listModels(): Promise<string[]> {
    if (!this.client) return [];
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }

  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    if (!this.client) {
      throw new ProviderError(
        "target",
        this.name,
        inv.model,
        "Provider 'anthropic' has no credential configured.",
      );
    }

    const { system, messages } = splitSystem(inv.messages);

    try {
      const res = await this.client.messages.create(
        {
          model: inv.model,
          max_tokens: inv.maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...(inv.temperature !== undefined ? { temperature: inv.temperature } : {}),
          ...(inv.topP !== undefined ? { top_p: inv.topP } : {}),
          ...(inv.stop?.length ? { stop_sequences: inv.stop } : {}),
        },
        { signal: inv.signal },
      );

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      return {
        text,
        finishReason: mapStopReason(res.stop_reason),
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        providerRequestId: res.id,
      };
    } catch (err) {
      throw toProviderError(err, this.name, inv.model);
    }
  }
}

function splitSystem(all: ChatMessage[]) {
  const systemParts: string[] = [];
  const rest: { role: "user" | "assistant"; content: string }[] = [];

  for (const m of all) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const last = rest[rest.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else rest.push({ role: m.role, content: m.content });
  }

  if (rest.length === 0) rest.push({ role: "user", content: "" });
  if (rest[0]!.role !== "user") rest.unshift({ role: "user", content: "(continue)" });

  return { system: systemParts.join("\n\n"), messages: rest };
}

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

function toProviderError(err: unknown, provider: string, model: string): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ProviderError("retryable", provider, model, "Attempt timed out.", 408);
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("retryable", provider, model, `Connection failed: ${err.message}`);
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const retryAfter = Number(
      (err.headers as Record<string, string> | undefined)?.["retry-after"] ?? NaN,
    );

    return new ProviderError(
      classifyStatus(status),
      provider,
      model,
      err.message,
      status,
      Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
    );
  }
  return new ProviderError(
    "retryable",
    provider,
    model,
    err instanceof Error ? err.message : String(err),
  );
}
