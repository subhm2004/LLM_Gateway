import { loadConfig } from "./config.ts";
import { reconcileCatalog } from "./reconcile.ts";
import { buildServer } from "./server.ts";

async function main() {
  const cfg = loadConfig();
  const { app, ctx } = await buildServer(cfg);

  const sweeper = setInterval(() => {
    void ctx.store
      .sweepExpiredReservations(new Date().toISOString())
      .then((n) => {
        if (n > 0) ctx.log.warn({ reclaimed: n }, "reclaimed expired budget reservations");
      })
      .catch((err) => ctx.log.error({ err }, "reservation sweep failed"));
  }, cfg.RESERVATION_SWEEP_INTERVAL_MS);
  sweeper.unref();

  void reconcileCatalog(ctx.catalog, ctx.registry, ctx.log)
    .then((r) => {
      ctx.health.catalog = r;
      ctx.log.info(
        { status: r.status, providers: r.providers.map((p) => `${p.provider}=${p.status}`) },
        "catalog reconciliation complete",
      );
    })
    .catch((err) => ctx.log.error({ err }, "catalog reconciliation failed"));

  await app.listen({ port: cfg.PORT, host: cfg.HOST });

  ctx.log.info(
    {
      port: cfg.PORT,
      store: ctx.store.dialect,
      routes: ctx.catalog.names().length,
      providers_configured: [...ctx.registry.entries()]
        .filter(([, p]) => p.isConfigured())
        .map(([n]) => n),
      cache_enabled: cfg.CACHE_ENABLED,
    },
    "llm-gateway listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info({ signal }, "shutting down");
    clearInterval(sweeper);
    try {
      await app.close();
      await ctx.store.close();
      process.exit(0);
    } catch (err) {
      ctx.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    ctx.log.error({ reason }, "unhandled promise rejection");
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
