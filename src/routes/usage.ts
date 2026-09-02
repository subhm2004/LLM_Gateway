import { authenticateKey } from "../auth.ts";
import type { App, AppContext } from "../context.ts";
import { microsToUsd } from "../pricing.ts";

export function registerUsageRoute(app: App, ctx: AppContext) {
  app.get("/v1/usage", async (req) => {
    const record = await authenticateKey(ctx.store, req.headers as Record<string, unknown>);

    const q = req.query as { since?: string; limit?: string };
    const summary = await ctx.store.usageSummary(record.id, q.since);
    const byModel = await ctx.store.modelBreakdown(record.id, q.since);
    const events = await ctx.store.recentEvents(record.id, Math.min(Number(q.limit ?? 20), 200));

    const remaining = Math.max(
      0,
      record.budget_micros - record.spent_micros - record.reserved_micros,
    );

    return {
      key: {
        id: record.id,
        name: record.name,
        key_prefix: record.key_prefix,
        status: record.status,
        budget_micro_usd: record.budget_micros,
        budget_usd: microsToUsd(record.budget_micros),
        spent_micro_usd: record.spent_micros,
        spent_usd: microsToUsd(record.spent_micros),
        reserved_micro_usd: record.reserved_micros,
        remaining_micro_usd: remaining,
        remaining_usd: microsToUsd(remaining),
      },
      usage: { ...summary, cost_usd: microsToUsd(summary.cost_micros) },
      by_model: byModel.map((r) => ({ ...r, cost_usd: microsToUsd(r.cost_micros) })),
      recent_events: events,
    };
  });
}
