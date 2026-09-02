import type { App, AppContext } from "../context.ts";

export function registerMetaRoutes(app: App, ctx: AppContext) {
  app.get("/health", async () => ({ status: "ok", uptime_s: Math.round(process.uptime()) }));

  app.get("/ready", async (_req, reply) => {
    try {
      await ctx.store.listKeys();
      return { status: "ready", store: ctx.store.dialect };
    } catch (err) {
      ctx.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ status: "not_ready", reason: "datastore unreachable" });
    }
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: ctx.catalog.list().map((r) => ({
      id: r.name,
      object: "model",
      owned_by: "llm-gateway",
      created: 0,

      gateway: {
        description: r.description,
        fallback_chain: r.targets.map((t) => ({
          provider: t.provider,
          model: t.model,
          input_usd_per_mtok: t.input_usd_per_mtok,
          output_usd_per_mtok: t.output_usd_per_mtok,
          configured: ctx.registry.get(t.provider)?.isConfigured() ?? false,
        })),
      },
    })),
    gateway: { priced_at: ctx.catalog.pricedAt, pricing_sources: ctx.catalog.pricingSources },
  }));
}
