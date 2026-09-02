import type { Config } from "../config.ts";
import type { Provider } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";

export type ProviderRegistry = Map<string, Provider>;

export function buildProviders(cfg: Config): ProviderRegistry {
  const reg: ProviderRegistry = new Map();

  reg.set(
    "groq",
    new OpenAICompatProvider({
      name: "groq",
      baseURL: cfg.GROQ_BASE_URL,
      apiKey: cfg.GROQ_API_KEY,
      timeoutMs: cfg.PROVIDER_TIMEOUT_MS,
      maxTokensField: "max_tokens",
    }),
  );

  reg.set(
    "openai",
    new OpenAICompatProvider({
      name: "openai",
      baseURL: cfg.OPENAI_BASE_URL,
      apiKey: cfg.OPENAI_API_KEY,
      timeoutMs: cfg.PROVIDER_TIMEOUT_MS,
      maxTokensField: "max_completion_tokens",
    }),
  );

  if (cfg.OLLAMA_ENABLED) {
    reg.set(
      "ollama",
      new OpenAICompatProvider({
        name: "ollama",
        baseURL: cfg.OLLAMA_BASE_URL,

        apiKey: "ollama",
        timeoutMs: cfg.PROVIDER_TIMEOUT_MS,
        maxTokensField: "max_tokens",
      }),
    );
  }

  reg.set("anthropic", new AnthropicProvider(cfg.ANTHROPIC_API_KEY, cfg.PROVIDER_TIMEOUT_MS));
  reg.set("mock", new MockProvider());

  return reg;
}

export { MockProvider, OpenAICompatProvider, AnthropicProvider };
export { FaultInjector } from "./mock.ts";
