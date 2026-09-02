import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { ZodError } from "zod";
import { CircuitBreaker } from "./breaker.ts";
import { ResponseCache } from "./cache.ts";
import { Catalog } from "./catalog.ts";
import type { Config } from "./config.ts";
import type { App, AppContext } from "./context.ts";
import { GatewayError } from "./errors.ts";
import { createLogger } from "./logger.ts";
import { buildProviders, FaultInjector } from "./providers/index.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerChatRoute } from "./routes/chat.ts";
import { registerMetaRoutes } from "./routes/meta.ts";
import { registerUsageRoute } from "./routes/usage.ts";
import { createStore, type Store } from "./store/index.ts";

export interface BuiltServer {
  app: App;
  ctx: AppContext;
}

export async function buildServer(
  cfg: Config,
  opts: { store?: Store; registry?: ProviderRegistry; allowFaultInjection?: boolean } = {},
): Promise<BuiltServer> {
  const log = createLogger(cfg.LOG_LEVEL, !cfg.isProd);

  const store =
    opts.store ??
    (await createStore({
      databaseUrl: cfg.DATABASE_URL,
      sqlitePath: cfg.SQLITE_PATH,
      insecureTls: cfg.DATABASE_SSL_INSECURE,
    }));
  await store.init();

  const ctx: AppContext = {
    cfg,
    store,
    catalog: Catalog.load(cfg.MODEL_CATALOG_PATH),
    registry: opts.registry ?? buildProviders(cfg),
    breaker: new CircuitBreaker(cfg.BREAKER_FAILURE_THRESHOLD, cfg.BREAKER_COOLDOWN_MS),
    cache: new ResponseCache(cfg.CACHE_ENABLED, cfg.CACHE_MAX_ENTRIES, cfg.CACHE_TTL_MS),
    faults: new FaultInjector(
      opts.allowFaultInjection ?? /^(1|true|yes|on)$/i.test(process.env.ALLOW_FAULT_INJECTION ?? ""),
    ),
    log,
    health: { catalog: null },
  };

  const app = Fastify({
    loggerInstance: log,

    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = (reply.getHeader("x-gateway-request-id") as string) ?? req.id;

    if (err instanceof GatewayError) {
      req.log.warn(
        { code: err.code, status: err.httpStatus, request_id: requestId },
        "request rejected",
      );
      return reply.code(err.httpStatus).send(err.toBody(requestId));
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          message: "Request body failed validation.",
          type: "invalid_request_error",
          code: "invalid_request",
          param: null,
          details: { issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        },
        gateway: { request_id: requestId },
      });
    }

    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          message: e.message,
          type: "invalid_request_error",
          code: e.code ?? "bad_request",
          param: null,
        },
        gateway: { request_id: requestId },
      });
    }

    req.log.error({ err, request_id: requestId }, "unhandled error");
    return reply.code(500).send({
      error: {
        message: "Internal gateway error.",
        type: "api_error",
        code: "internal_error",
        param: null,
      },
      gateway: { request_id: requestId },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        message: `No route ${req.method} ${req.url}.`,
        type: "invalid_request_error",
        code: "not_found",
        param: null,
      },
    }),
  );

  registerMetaRoutes(app, ctx);
  registerChatRoute(app, ctx);
  registerUsageRoute(app, ctx);
  registerAdminRoutes(app, ctx);

  let dashboard: string | null = null;
  app.get("/dashboard", async (_req, reply) => {
    dashboard ??= readFileSync("./public/dashboard.html", "utf8");
    return reply.type("text/html; charset=utf-8").send(dashboard);
  });

  app.get("/", async () => ({
    service: "llm-gateway",
    endpoints: {
      chat: "POST /v1/chat/completions",
      models: "GET /v1/models",
      own_usage: "GET /v1/usage",
      admin_keys: "POST|GET /admin/keys",
      admin_usage: "GET /admin/usage?key_id=...",
      admin_stats: "GET /admin/stats",
      dashboard: "GET /dashboard",
      health: "GET /health",
      ready: "GET /ready",
    },
  }));

  return { app, ctx };
}
