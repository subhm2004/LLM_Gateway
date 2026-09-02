export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Target {
  provider: string;
  model: string;
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  context_window: number;
  default_max_tokens: number;
}

export interface Route {
  name: string;
  description: string;
  targets: Target[];
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  budget_micros: number;
  spent_micros: number;
  reserved_micros: number;
  status: "active" | "disabled";
  created_at: string;
}

export interface UsageEvent {
  id: string;
  request_id: string;
  key_id: string;
  requested_model: string;
  served_provider: string | null;
  served_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  status: "ok" | "error" | "blocked";
  http_status: number | null;
  error_code: string | null;
  cache_hit: number;
  fallback_used: number;
  attempts: number;
  latency_ms: number;
  created_at: string;
}

export interface ProviderResult {
  text: string;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;

  reasoningTokens?: number;
  providerRequestId?: string;
}

export interface ProviderInvocation {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  signal: AbortSignal;
}

export interface Provider {
  readonly name: string;

  isConfigured(): boolean;
  invoke(inv: ProviderInvocation): Promise<ProviderResult>;
  listModels?(): Promise<string[]>;
}

export interface AttemptRecord {
  provider: string;
  model: string;
  outcome: "ok" | "error" | "skipped_unconfigured" | "skipped_breaker_open";
  status?: number | null;
  kind?: string;
  message?: string;
  latency_ms: number;
}
