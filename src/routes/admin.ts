import { randomUUID } from "node:crypto";
import { adminTokenMatches, extractBearer, generateVirtualKey } from "../auth.ts";
import type { App, AppContext } from "../context.ts";
import { forbidden, invalidRequest } from "../errors.ts";
import { microsToUsd, usdToMicros } from "../pricing.ts";
import { z } from "zod";
import type { ApiKeyRecord } from "../types.ts";

const CreateKeySchema = z
  .object({
    name: z.string().min(1).max(120),
    budget_usd: z.number().positive().optional(),
    budget_micro_usd: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.budget_usd !== undefined || v.budget_micro_usd !== undefined, {
    message: "Provide either budget_usd or budget_micro_usd.",
  });

const PatchKeySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    budget_usd: z.number().positive().optional(),
    budget_micro_usd: z.number().int().positive().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();

export function registerAdminRoutes(app: App, ctx: AppContext) {
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/admin")) return;
    const presented = extractBearer(req.headers as Record<string, unknown>);
    if (!adminTokenMatches(presented, ctx.cfg.ADMIN_TOKEN)) {
      throw forbidden("Admin token required.", "admin_token_required");
    }
  });

  app.post("/admin/keys", async (req, reply) => {
    const parsed = CreateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      throw invalidRequest("Invalid key definition.", {
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const b = parsed.data;
    const budgetMicros = b.budget_micro_usd ?? usdToMicros(b.budget_usd!);

    const { key, prefix, hash } = generateVirtualKey();
    const record = await ctx.store.createKey({
      id: `vk_${randomUUID()}`,
      name: b.name,
      key_prefix: prefix,
      key_hash: hash,
      budget_micros: budgetMicros,
      created_at: new Date().toISOString(),
    });

    ctx.log.info({ key_id: record.id, name: record.name }, "virtual key created");

    return reply.code(201).send({
      ...decorate(record),

      key,
      warning: "Store this key now. It is not recoverable — only its hash is stored.",
    });
  });

  app.get("/admin/keys", async () => {
    const keys = await ctx.store.listKeys();
    return { keys: keys.map(decorate) };
  });

  app.get("/admin/keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const key = await ctx.store.getKey(id);
    if (!key) return reply.code(404).send({ error: { message: "No such key.", code: "not_found" } });
    const summary = await ctx.store.usageSummary(id);
    const breakdown = await ctx.store.modelBreakdown(id);
    return { ...decorate(key), usage: decorateSummary(summary), by_model: breakdown };
  });

  app.patch("/admin/keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchKeySchema.safeParse(req.body);
    if (!parsed.success) {
      throw invalidRequest("Invalid patch.", {
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const p = parsed.data;
    const patch: { name?: string; budget_micros?: number; status?: "active" | "disabled" } = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.status !== undefined) patch.status = p.status;
    if (p.budget_micro_usd !== undefined) patch.budget_micros = p.budget_micro_usd;
    else if (p.budget_usd !== undefined) patch.budget_micros = usdToMicros(p.budget_usd);

    const key = await ctx.store.updateKey(id, patch);
    if (!key) return reply.code(404).send({ error: { message: "No such key.", code: "not_found" } });
    ctx.log.info({ key_id: id, patch }, "virtual key updated");
    return decorate(key);
  });

  app.get("/admin/usage", async (req, reply) => {
    const q = req.query as { key_id?: string; since?: string; limit?: string };
    if (!q.key_id) throw invalidRequest("Query parameter 'key_id' is required.");
    const key = await ctx.store.getKey(q.key_id);
    if (!key) return reply.code(404).send({ error: { message: "No such key.", code: "not_found" } });

    const summary = await ctx.store.usageSummary(q.key_id, q.since);
    const byModel = await ctx.store.modelBreakdown(q.key_id, q.since);
    const events = await ctx.store.recentEvents(q.key_id, Math.min(Number(q.limit ?? 50), 500));
    return {
      key: decorate(key),
      usage: decorateSummary(summary),
      by_model: byModel.map((r) => ({ ...r, cost_usd: microsToUsd(r.cost_micros) })),
      recent_events: events,
    };
  });

  app.get("/admin/stats", async () => ({
    circuit_breakers: ctx.breaker.snapshot(),
    cache: ctx.cache.stats(),
    providers: [...ctx.registry.entries()].map(([name, p]) => ({
      name,
      configured: p.isConfigured(),
    })),
    catalog: {
      priced_at: ctx.catalog.pricedAt,
      routes: ctx.catalog.names(),
      reconciliation: ctx.health.catalog,
    },
    store: ctx.store.dialect,

    fault_injection_enabled: ctx.faults.isEnabled,
  }));
}

function decorate(k: ApiKeyRecord) {
  const { budget_micros, spent_micros, reserved_micros, ...rest } = k;
  const remaining = Math.max(0, budget_micros - spent_micros - reserved_micros);
  return {
    ...rest,
    budget_micro_usd: budget_micros,
    spent_micro_usd: spent_micros,
    reserved_micro_usd: reserved_micros,
    remaining_micro_usd: remaining,
    budget_usd: microsToUsd(budget_micros),
    spent_usd: microsToUsd(spent_micros),
    remaining_usd: microsToUsd(remaining),
  };
}

function decorateSummary<T extends { cost_micros: number }>(s: T) {
  return { ...s, cost_usd: microsToUsd(s.cost_micros) };
}
