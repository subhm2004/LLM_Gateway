import type { Catalog } from "./catalog.ts";
import type { Logger } from "./logger.ts";
import type { ProviderRegistry } from "./providers/index.ts";

export type ProviderReconcileStatus = "ok" | "drift" | "unverified" | "unconfigured" | "no_adapter";

export interface ProviderReconcile {
  provider: string;
  status: ProviderReconcileStatus;
  catalog_models: string[];
  missing: string[];
  error?: string;
}

export interface ReconcileResult {
  checked_at: string;
  status: "ok" | "drift" | "unverified";
  providers: ProviderReconcile[];
}

export async function reconcileCatalog(
  catalog: Catalog,
  registry: ProviderRegistry,
  log: Pick<Logger, "warn" | "info" | "error">,
  timeoutMs = 10_000,
): Promise<ReconcileResult> {
  const wanted = new Map<string, Set<string>>();
  for (const route of catalog.list()) {
    for (const t of route.targets) {
      if (!wanted.has(t.provider)) wanted.set(t.provider, new Set());
      wanted.get(t.provider)!.add(t.model);
    }
  }

  const providers: ProviderReconcile[] = [];

  for (const [name, models] of wanted) {
    const catalogModels = [...models].sort();
    const adapter = registry.get(name);

    if (!adapter) {
      providers.push({
        provider: name,
        status: "no_adapter",
        catalog_models: catalogModels,
        missing: catalogModels,
        error: `No adapter registered for provider '${name}'.`,
      });
      continue;
    }
    if (!adapter.isConfigured()) {
      providers.push({ provider: name, status: "unconfigured", catalog_models: catalogModels, missing: [] });
      continue;
    }
    if (!adapter.listModels) {
      providers.push({ provider: name, status: "unverified", catalog_models: catalogModels, missing: [] });
      continue;
    }

    try {
      const live = await withTimeout(adapter.listModels(), timeoutMs);
      const liveSet = new Set(live);
      const missing = catalogModels.filter((m) => !liveSet.has(m));
      providers.push({
        provider: name,
        status: missing.length ? "drift" : "ok",
        catalog_models: catalogModels,
        missing,
      });
    } catch (err) {
      providers.push({
        provider: name,
        status: "unverified",
        catalog_models: catalogModels,
        missing: [],
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  const status = providers.some((p) => p.status === "drift" || p.status === "no_adapter")
    ? "drift"
    : providers.some((p) => p.status === "unverified")
      ? "unverified"
      : "ok";

  for (const p of providers) {
    if (p.missing.length) {
      log.warn(
        { provider: p.provider, missing: p.missing },
        "CATALOG DRIFT: models in config/models.json are not offered by the provider. " +
          "Requests routed to them will fail and silently fall through the chain.",
      );
    } else if (p.status === "unverified") {
      log.info({ provider: p.provider, reason: p.error ?? "no model listing" }, "catalog unverified");
    }
  }

  return { checked_at: new Date().toISOString(), status, providers };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`model listing timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
