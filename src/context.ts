import type {
  FastifyInstance,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { CircuitBreaker } from "./breaker.ts";
import type { ResponseCache } from "./cache.ts";
import type { Catalog } from "./catalog.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { FaultInjector, ProviderRegistry } from "./providers/index.ts";
import type { ReconcileResult } from "./reconcile.ts";
import type { Store } from "./store/index.ts";

export interface AppContext {
  cfg: Config;
  store: Store;
  catalog: Catalog;
  registry: ProviderRegistry;
  breaker: CircuitBreaker;
  cache: ResponseCache;
  faults: FaultInjector;
  log: Logger;
  health: { catalog: ReconcileResult | null };
}

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger,
  FastifyTypeProviderDefault
>;
