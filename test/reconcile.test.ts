import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Catalog } from "../src/catalog.ts";
import { reconcileCatalog } from "../src/reconcile.ts";
import type { Provider, ProviderResult } from "../src/types.ts";

const silent = { warn() {}, info() {}, error() {} };

class Listing implements Provider {
  constructor(readonly name: string, private readonly models: string[], private readonly configured = true) {}
  isConfigured() { return this.configured; }
  async listModels() { return this.models; }
  async invoke(): Promise<ProviderResult> { throw new Error("not used"); }
}

class NoListing implements Provider {
  constructor(readonly name: string) {}
  isConfigured() { return true; }
  async invoke(): Promise<ProviderResult> { throw new Error("not used"); }
}

class Broken implements Provider {
  constructor(readonly name: string) {}
  isConfigured() { return true; }
  async listModels(): Promise<string[]> { throw new Error("network down"); }
  async invoke(): Promise<ProviderResult> { throw new Error("not used"); }
}

const catalog = Catalog.load("./test/fixtures/models.test.json");
const catalogModels = [...new Set(catalog.list().flatMap((r) => r.targets.map((t) => t.model)))];

describe("catalog reconciliation", () => {
  it("reports ok when the provider offers every catalogued model", async () => {
    const reg = new Map<string, Provider>(
      ["stub", "boom", "boom2", "badreq", "nokey"].map((n) => [n, new Listing(n, catalogModels)]),
    );
    const r = await reconcileCatalog(catalog, reg, silent);
    assert.equal(r.status, "ok");
    assert.ok(r.providers.every((p) => p.missing.length === 0));
  });

  it("detects drift when a model the catalog routes to no longer exists", async () => {
    const reg = new Map<string, Provider>(
      ["stub", "boom", "boom2", "badreq", "nokey"].map((n) => [n, new Listing(n, [])]),
    );
    const r = await reconcileCatalog(catalog, reg, silent);
    assert.equal(r.status, "drift");
    const stub = r.providers.find((p) => p.provider === "stub")!;
    assert.ok(stub.missing.includes("stub-1"), "the retired model is named in the report");
  });

  it("does not call a provider that has no credential", async () => {
    let called = false;
    class Watch extends Listing {
      override async listModels() { called = true; return []; }
    }
    const reg = new Map<string, Provider>([["stub", new Watch("stub", [], false)]]);
    const r = await reconcileCatalog(catalog, reg, silent);
    assert.equal(called, false);
    assert.equal(r.providers.find((p) => p.provider === "stub")?.status, "unconfigured");
  });

  it("reports unverified rather than drift when the listing call fails", async () => {
    const reg = new Map<string, Provider>([["stub", new Broken("stub")]]);
    const r = await reconcileCatalog(catalog, reg, silent);
    const stub = r.providers.find((p) => p.provider === "stub")!;
    assert.equal(stub.status, "unverified");
    assert.equal(stub.missing.length, 0, "an unreachable provider must not be reported as drift");
    assert.match(stub.error ?? "", /network down/);
  });

  it("reports unverified when a provider cannot list models at all", async () => {
    const reg = new Map<string, Provider>([["stub", new NoListing("stub")]]);
    const r = await reconcileCatalog(catalog, reg, silent);
    assert.equal(r.providers.find((p) => p.provider === "stub")?.status, "unverified");
  });

  it("flags a catalog target with no registered adapter", async () => {
    const r = await reconcileCatalog(catalog, new Map(), silent);
    assert.equal(r.status, "drift");
    assert.ok(r.providers.every((p) => p.status === "no_adapter"));
  });
});
