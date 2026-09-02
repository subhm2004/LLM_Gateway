export class GatewayError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly type: string,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  toBody(requestId: string) {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        param: null,
        ...(this.details ? { details: this.details } : {}),
      },
      gateway: { request_id: requestId },
    };
  }
}

export const invalidRequest = (msg: string, details?: Record<string, unknown>) =>
  new GatewayError(400, "invalid_request_error", "invalid_request", msg, details);

export const unauthorized = (msg = "Missing or invalid gateway API key.") =>
  new GatewayError(401, "authentication_error", "invalid_api_key", msg);

export const forbidden = (msg: string, code = "key_disabled") =>
  new GatewayError(403, "permission_error", code, msg);

export const budgetExceeded = (details: Record<string, unknown>) =>
  new GatewayError(
    402,
    "budget_exceeded",
    "budget_exceeded",
    "Budget exhausted for this key. Raise the cap via the admin API to continue.",
    details,
  );

export const unknownModel = (model: string, known: string[]) =>
  new GatewayError(
    404,
    "invalid_request_error",
    "model_not_found",
    `Unknown model '${model}'. This gateway routes only the models in its catalog.`,
    { available_models: known },
  );

export const upstreamFailure = (details: Record<string, unknown>) =>
  new GatewayError(
    502,
    "upstream_error",
    "all_providers_failed",
    "Every provider in the fallback chain failed. No tokens were billed.",
    details,
  );

export const deadlineExceeded = (details: Record<string, unknown>) =>
  new GatewayError(
    504,
    "upstream_error",
    "deadline_exceeded",
    "Request deadline exceeded before any provider returned. No tokens were billed.",
    details,
  );

export type ProviderFailureKind = "caller" | "target" | "retryable";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    readonly provider: string,
    readonly model: string,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  summary() {
    return {
      provider: this.provider,
      model: this.model,
      kind: this.kind,
      status: this.status ?? null,
      message: this.message.slice(0, 300),
    };
  }
}

export function classifyStatus(status: number | undefined): ProviderFailureKind {
  if (status === undefined) return "retryable";
  if (status === 408 || status === 409 || status === 429) return "retryable";
  if (status >= 500) return "retryable";
  if (status === 401 || status === 403 || status === 404) return "target";
  return "caller";
}
