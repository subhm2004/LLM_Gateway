import type { CircuitBreaker } from "./breaker.ts";
import {
  GatewayError,
  ProviderError,
  deadlineExceeded,
  invalidRequest,
  upstreamFailure,
} from "./errors.ts";
import type { FaultInjector } from "./providers/mock.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import type { AttemptRecord, ChatMessage, ProviderResult, Target } from "./types.ts";

export interface DispatchArgs {
  targets: Target[];
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string[] | undefined;
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  faults: { injector: FaultInjector; failing: Set<string> };
  policy: {
    providerTimeoutMs: number;
    deadlineMs: number;
    maxRetriesPerTarget: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  };
}

export interface DispatchOutcome {
  result: ProviderResult;
  target: Target;
  attempts: AttemptRecord[];
  fallbackUsed: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function dispatch(args: DispatchArgs): Promise<DispatchOutcome> {
  const { targets, registry, breaker, policy } = args;
  const attempts: AttemptRecord[] = [];
  const startedAt = Date.now();
  const deadline = startedAt + policy.deadlineMs;

  for (let ti = 0; ti < targets.length; ti++) {
    const target = targets[ti]!;
    const targetKey = `${target.provider}:${target.model}`;

    const base = registry.get(target.provider);
    if (!base) {
      attempts.push({
        provider: target.provider,
        model: target.model,
        outcome: "skipped_unconfigured",
        message: `No adapter registered for provider '${target.provider}'.`,
        latency_ms: 0,
      });
      continue;
    }

    const provider = args.faults.injector.wrap(base, args.faults.failing);

    if (!provider.isConfigured()) {
      attempts.push({
        provider: target.provider,
        model: target.model,
        outcome: "skipped_unconfigured",
        message: `No credential configured for '${target.provider}'.`,
        latency_ms: 0,
      });
      continue;
    }

    if (breaker.isOpen(targetKey)) {
      attempts.push({
        provider: target.provider,
        model: target.model,
        outcome: "skipped_breaker_open",
        message: "Circuit breaker open for this target.",
        latency_ms: 0,
      });
      continue;
    }

    for (let attempt = 0; attempt <= policy.maxRetriesPerTarget; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw deadlineExceeded({ attempts, elapsed_ms: Date.now() - startedAt });
      }

      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new Error("per-attempt timeout")),
        Math.min(policy.providerTimeoutMs, remaining),
      );
      const t0 = Date.now();

      try {
        const result = await provider.invoke({
          model: target.model,
          messages: args.messages,
          maxTokens: args.maxTokens,
          temperature: args.temperature,
          topP: args.topP,
          stop: args.stop,
          signal: ac.signal,
        });

        breaker.recordSuccess(targetKey);
        attempts.push({
          provider: target.provider,
          model: target.model,
          outcome: "ok",
          latency_ms: Date.now() - t0,
        });
        return { result, target, attempts, fallbackUsed: ti > 0 };
      } catch (err) {
        const pe =
          err instanceof ProviderError
            ? err
            : new ProviderError(
                "retryable",
                target.provider,
                target.model,
                err instanceof Error ? err.message : String(err),
              );

        attempts.push({
          provider: target.provider,
          model: target.model,
          outcome: "error",
          status: pe.status ?? null,
          kind: pe.kind,
          message: pe.message.slice(0, 300),
          latency_ms: Date.now() - t0,
        });

        if (pe.kind === "caller") {
          throw invalidRequest(
            `Provider rejected the request as invalid: ${pe.message}`,
            { provider: pe.provider, model: pe.model, provider_status: pe.status ?? null },
          );
        }

        breaker.recordFailure(targetKey);

        if (pe.kind === "target") break;
        if (attempt === policy.maxRetriesPerTarget) break;

        const delay = backoffDelay(attempt, policy, pe.retryAfterMs);
        if (Date.now() + delay >= deadline) break;
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  throw upstreamFailure({ attempts, elapsed_ms: Date.now() - startedAt });
}

function backoffDelay(
  attempt: number,
  policy: { retryBaseDelayMs: number; retryMaxDelayMs: number },
  retryAfterMs?: number,
): number {
  const capped = Math.min(policy.retryBaseDelayMs * 2 ** attempt, policy.retryMaxDelayMs);
  const jittered = Math.random() * capped;
  return Math.max(jittered, retryAfterMs ?? 0);
}

export { GatewayError };
