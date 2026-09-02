import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Route, Target } from "./types.ts";

const TargetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  input_usd_per_mtok: z.number().min(0),
  output_usd_per_mtok: z.number().min(0),
  context_window: z.number().int().positive(),
  default_max_tokens: z.number().int().positive(),
});

const CatalogSchema = z.object({
  version: z.number(),
  priced_at: z.string(),
  pricing_sources: z.record(z.string(), z.string()),
  routes: z.record(
    z.string(),
    z.object({
      description: z.string(),
      targets: z.array(TargetSchema).min(1),
    }),
  ),
});

export class Catalog {
  private constructor(
    readonly pricedAt: string,
    readonly pricingSources: Record<string, string>,
    private readonly routes: Map<string, Route>,
  ) {}

  static load(path: string): Catalog {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = CatalogSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid model catalog at ${path}:\n` +
          parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
      );
    }
    const routes = new Map<string, Route>();
    for (const [name, def] of Object.entries(parsed.data.routes)) {
      routes.set(name, { name, description: def.description, targets: def.targets });
    }
    return new Catalog(parsed.data.priced_at, parsed.data.pricing_sources, routes);
  }

  get(name: string): Route | undefined {
    return this.routes.get(name);
  }

  names(): string[] {
    return [...this.routes.keys()];
  }

  list(): Route[] {
    return [...this.routes.values()];
  }

  worstCaseTarget(route: Route, outputTokens: number, inputTokens: number): Target {
    let worst = route.targets[0]!;
    let worstCost = -1;
    for (const t of route.targets) {
      const c = inputTokens * t.input_usd_per_mtok + outputTokens * t.output_usd_per_mtok;
      if (c > worstCost) {
        worstCost = c;
        worst = t;
      }
    }
    return worst;
  }
}
