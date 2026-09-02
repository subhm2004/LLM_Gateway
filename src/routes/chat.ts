import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authenticateKey } from "../auth.ts";
import { ResponseCache } from "../cache.ts";
import type { App, AppContext } from "../context.ts";
import { dispatch } from "../dispatch.ts";
import {
  GatewayError,
  budgetExceeded,
  forbidden,
  invalidRequest,
  unauthorized,
  unknownModel,
} from "../errors.ts";
import { costMicros } from "../pricing.ts";
import { ChatRequestSchema, flattenContent, normalizeStop } from "../schema.ts";
import { estimateInputTokens } from "../tokens.ts";
import type { ApiKeyRecord, ChatMessage, ProviderResult, Target, UsageEvent } from "../types.ts";

const HARD_MAX_OUTPUT_TOKENS = 8192;

export function registerChatRoute(app: App, ctx: AppContext) {
  app.post("/v1/chat/completions", async (req, reply) => {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const startedAt = Date.now();
    reply.header("x-gateway-request-id", requestId);

    const key = await authenticateKey(ctx.store, req.headers as Record<string, unknown>);

    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw invalidRequest("Request body failed validation.", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const body = parsed.data;

    if (body.stream) {
      throw invalidRequest(
        "This gateway is non-streaming. Budget enforcement settles against the " +
          "provider's reported token usage, which only exists once the response " +
          "is complete. Re-send without `stream: true`.",
        { supported: false, see: "DECISIONS.md#streaming" },
      );
    }
    if (body.n !== undefined && body.n !== 1) {
      throw invalidRequest("Only n=1 is supported.");
    }

    const route = ctx.catalog.get(body.model);
    if (!route) throw unknownModel(body.model, ctx.catalog.names());

    const messages: ChatMessage[] = body.messages.map((m) => ({
      role: m.role,
      content: flattenContent(m.content),
    }));
    const stop = normalizeStop(body.stop);

    const requestedMax = body.max_tokens ?? body.max_completion_tokens;
    const maxTokens = Math.min(
      requestedMax ?? route.targets[0]!.default_max_tokens,
      HARD_MAX_OUTPUT_TOKENS,
    );

    const estimatedInput = estimateInputTokens(messages);

    const minContext = Math.min(...route.targets.map((t) => t.context_window));
    if (estimatedInput + maxTokens > minContext) {
      throw invalidRequest(
        `Request does not fit every model in route '${route.name}'. Estimated ` +
          `${estimatedInput} input + ${maxTokens} output tokens exceeds the ` +
          `smallest context window in the chain (${minContext}).`,
        { estimated_input_tokens: estimatedInput, max_tokens: maxTokens, min_context: minContext },
      );
    }

    const safeInput = Math.ceil(estimatedInput * ctx.cfg.ESTIMATE_SAFETY_FACTOR);
    const worst = ctx.catalog.worstCaseTarget(route, maxTokens, safeInput);
    const reserveMicros = Math.max(1, costMicros(worst, safeInput, maxTokens));

    const baseEvent = {
      request_id: requestId,
      key_id: key.id,
      requested_model: body.model,
      created_at: new Date().toISOString(),
    };

    if (key.status !== "active") {
      await logBlocked(ctx, baseEvent, 403, "key_disabled", startedAt);
      throw forbidden("This key is disabled.");
    }

    const cacheable = ctx.cache.cacheable(body.temperature);
    const cacheKey = cacheable
      ? ResponseCache.keyFor({
          route: route.name,
          messages,
          maxTokens,
          temperature: body.temperature,
          topP: body.top_p,
          stop,
        })
      : null;

    if (cacheKey) {
      const hit = ctx.cache.get(cacheKey);
      if (hit) {
        await ctx.store.recordEvent({
          ...baseEvent,
          served_provider: hit.target.provider,
          served_model: hit.target.model,
          input_tokens: hit.result.inputTokens,
          output_tokens: hit.result.outputTokens,
          cost_micros: 0,
          status: "ok",
          http_status: 200,
          error_code: null,
          cache_hit: 1,
          fallback_used: 0,
          attempts: 0,
          latency_ms: Date.now() - startedAt,
        });
        return sendCompletion(reply, {
          requestId,
          route: route.name,
          target: hit.target,
          result: hit.result,
          costMicros: 0,
          key,
          cacheHit: true,
          fallbackUsed: false,
          attempts: 0,
          latencyMs: Date.now() - startedAt,
        });
      }
    }

    const reservationId = randomUUID();
    const now = new Date();
    const reservation = await ctx.store.reserve(
      key.id,
      reserveMicros,
      reservationId,
      now.toISOString(),
      new Date(now.getTime() + ctx.cfg.RESERVATION_TTL_MS).toISOString(),
    );

    if (!reservation.ok) {
      if (reservation.reason === "disabled") {
        await logBlocked(ctx, baseEvent, 403, "key_disabled", startedAt);
        throw forbidden("This key is disabled.");
      }
      if (reservation.reason === "not_found") {
        await logBlocked(ctx, baseEvent, 401, "invalid_api_key", startedAt);
        throw unauthorized();
      }
      const k = reservation.key!;
      await logBlocked(ctx, baseEvent, 402, "budget_exceeded", startedAt);
      throw budgetExceeded({
        budget_micro_usd: k.budget_micros,
        spent_micro_usd: k.spent_micros,
        reserved_micro_usd: k.reserved_micros,
        required_micro_usd: reserveMicros,
      });
    }

    let served: { result: ProviderResult; target: Target; attempts: number; fallback: boolean };
    try {
      const outcome = await dispatch({
        targets: route.targets,
        messages,
        maxTokens,
        temperature: body.temperature,
        topP: body.top_p,
        stop,
        registry: ctx.registry,
        breaker: ctx.breaker,
        faults: {
          injector: ctx.faults,
          failing: ctx.faults.parse(req.headers["x-gateway-fail-providers"]),
        },
        policy: {
          providerTimeoutMs: ctx.cfg.PROVIDER_TIMEOUT_MS,
          deadlineMs: ctx.cfg.REQUEST_DEADLINE_MS,
          maxRetriesPerTarget: ctx.cfg.MAX_RETRIES_PER_TARGET,
          retryBaseDelayMs: ctx.cfg.RETRY_BASE_DELAY_MS,
          retryMaxDelayMs: ctx.cfg.RETRY_MAX_DELAY_MS,
        },
      });
      served = {
        result: outcome.result,
        target: outcome.target,
        attempts: outcome.attempts.length,
        fallback: outcome.fallbackUsed,
      };
    } catch (err) {
      const ge = err instanceof GatewayError ? err : null;
      await ctx.store.settle({
        reservationId,
        keyId: key.id,
        reservedMicros: reserveMicros,
        actualMicros: 0,
        event: {
          ...baseEvent,
          served_provider: null,
          served_model: null,
          input_tokens: 0,
          output_tokens: 0,
          cost_micros: 0,
          status: "error",
          http_status: ge?.httpStatus ?? 500,
          error_code: ge?.code ?? "internal_error",
          cache_hit: 0,
          fallback_used: 0,
          attempts: (ge?.details?.attempts as unknown[] | undefined)?.length ?? 0,
          latency_ms: Date.now() - startedAt,
        },
      });
      throw err;
    }

    const actualMicros = costMicros(
      served.target,
      served.result.inputTokens,
      served.result.outputTokens,
    );
    const latencyMs = Date.now() - startedAt;

    const event: Omit<UsageEvent, "id"> = {
      ...baseEvent,
      served_provider: served.target.provider,
      served_model: served.target.model,
      input_tokens: served.result.inputTokens,
      output_tokens: served.result.outputTokens,
      cost_micros: actualMicros,
      status: "ok",
      http_status: 200,
      error_code: null,
      cache_hit: 0,
      fallback_used: served.fallback ? 1 : 0,
      attempts: served.attempts,
      latency_ms: latencyMs,
    };

    let keyAfter: ApiKeyRecord | null = null;
    try {
      keyAfter = await ctx.store.settle({
        reservationId,
        keyId: key.id,
        reservedMicros: reserveMicros,
        actualMicros,
        event,
      });
    } catch (err) {
      ctx.log.fatal(
        { err, ledger_row: event, reservation_id: reservationId },
        "SPEND NOT PERSISTED — provider call succeeded but the usage write failed. " +
          "This row must be reconciled by hand.",
      );
    }

    if (cacheKey) ctx.cache.set(cacheKey, { result: served.result, target: served.target });

    return sendCompletion(reply, {
      requestId,
      route: route.name,
      target: served.target,
      result: served.result,
      costMicros: actualMicros,
      key: keyAfter ?? key,
      cacheHit: false,
      fallbackUsed: served.fallback,
      attempts: served.attempts,
      latencyMs,
    });
  });
}

async function logBlocked(
  ctx: AppContext,
  base: { request_id: string; key_id: string; requested_model: string; created_at: string },
  httpStatus: number,
  code: string,
  startedAt: number,
) {
  await ctx.store.recordEvent({
    ...base,
    served_provider: null,
    served_model: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_micros: 0,
    status: "blocked",
    http_status: httpStatus,
    error_code: code,
    cache_hit: 0,
    fallback_used: 0,
    attempts: 0,
    latency_ms: Date.now() - startedAt,
  });
}

function sendCompletion(
  reply: FastifyReply,
  a: {
    requestId: string;
    route: string;
    target: Target;
    result: ProviderResult;
    costMicros: number;
    key: ApiKeyRecord;
    cacheHit: boolean;
    fallbackUsed: boolean;
    attempts: number;
    latencyMs: number;
  },
) {
  const remaining = Math.max(0, a.key.budget_micros - a.key.spent_micros - a.key.reserved_micros);

  const warn =
    a.result.text === "" && a.result.finishReason === "length"
      ? `Empty content: the response hit max_tokens${
          a.result.reasoningTokens
            ? ` after spending ${a.result.reasoningTokens} tokens on reasoning`
            : ""
        }. Raise max_tokens — these tokens were still billed.`
      : a.result.text === ""
        ? `Empty content returned by ${a.target.provider}/${a.target.model} (finish_reason: ${a.result.finishReason}).`
        : null;

  reply
    .header("x-gateway-provider", a.target.provider)
    .header("x-gateway-model", a.target.model)
    .header("x-gateway-cost-micro-usd", String(a.costMicros))
    .header("x-gateway-budget-remaining-micro-usd", String(remaining))
    .header("x-gateway-cache", a.cacheHit ? "hit" : "miss")
    .header("x-gateway-fallback", String(a.fallbackUsed));

  return reply.send({
    id: `chatcmpl-${a.requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),

    model: a.target.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: a.result.text },
        finish_reason: a.result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: a.result.inputTokens,
      completion_tokens: a.result.outputTokens,
      total_tokens: a.result.inputTokens + a.result.outputTokens,
      ...(a.result.reasoningTokens
        ? { completion_tokens_details: { reasoning_tokens: a.result.reasoningTokens } }
        : {}),
    },

    gateway: {
      request_id: a.requestId,
      requested_model: a.route,
      served_provider: a.target.provider,
      served_model: a.target.model,
      cost_micro_usd: a.costMicros,
      cache_hit: a.cacheHit,
      fallback_used: a.fallbackUsed,
      attempts: a.attempts,
      latency_ms: a.latencyMs,
      ...(a.result.reasoningTokens ? { reasoning_tokens: a.result.reasoningTokens } : {}),
      ...(warn ? { warning: warn } : {}),
      key_budget: {
        budget_micro_usd: a.key.budget_micros,
        spent_micro_usd: a.key.spent_micros,
        remaining_micro_usd: remaining,
      },
    },
  });
}
