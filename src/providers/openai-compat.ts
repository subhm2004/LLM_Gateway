import OpenAI from "openai";
import { ProviderError, classifyStatus } from "../errors.ts";
import type { Provider, ProviderInvocation, ProviderResult } from "../types.ts";

export interface OpenAICompatOptions {
  name: string;
  baseURL: string;
  apiKey: string | undefined;
  timeoutMs: number;

  maxTokensField: "max_tokens" | "max_completion_tokens";
}

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private client: OpenAI | null = null;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.name = opts.name;
    if (opts.apiKey) {
      this.client = new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,

        maxRetries: 0,
        timeout: opts.timeoutMs,
      });
    }
  }

  isConfigured() {
    return this.client !== null;
  }

  async listModels(): Promise<string[]> {
    if (!this.client) return [];
    const res = await this.client.models.list();
    return res.data.map((m) => m.id);
  }

  async invoke(inv: ProviderInvocation): Promise<ProviderResult> {
    if (!this.client) {
      throw new ProviderError(
        "target",
        this.name,
        inv.model,
        `Provider '${this.name}' has no credential configured.`,
      );
    }

    const body: Record<string, unknown> = {
      model: inv.model,
      messages: inv.messages.map((m) => ({ role: m.role, content: m.content })),
      [this.opts.maxTokensField]: inv.maxTokens,
    };
    if (inv.temperature !== undefined) body.temperature = inv.temperature;
    if (inv.topP !== undefined) body.top_p = inv.topP;
    if (inv.stop?.length) body.stop = inv.stop;

    try {
      const res = (await this.client.chat.completions.create(body as never, {
        signal: inv.signal,
      })) as OpenAI.Chat.Completions.ChatCompletion;

      const choice = res.choices?.[0];
      if (!choice) {
        throw new ProviderError(
          "retryable",
          this.name,
          inv.model,
          "Provider returned no choices.",
        );
      }

      const reasoningTokens = (
        res.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined
      )?.completion_tokens_details?.reasoning_tokens;

      return {
        text: choice.message?.content ?? "",
        finishReason: choice.finish_reason ?? "stop",
        ...(reasoningTokens ? { reasoningTokens } : {}),

        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        providerRequestId: res.id,
      };
    } catch (err) {
      throw toProviderError(err, this.name, inv.model);
    }
  }
}

function toProviderError(err: unknown, provider: string, model: string): ProviderError {
  if (err instanceof ProviderError) return err;

  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new ProviderError("retryable", provider, model, "Attempt timed out.", 408);
  }

  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError("retryable", provider, model, `Connection failed: ${err.message}`);
  }
  if (err instanceof OpenAI.APIError) {
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
