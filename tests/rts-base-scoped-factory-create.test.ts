import test from "node:test";
import assert from "node:assert/strict";
import { buildMobileRtsTree, createBaseScopedFactory } from "../dist/server/dashboard.js";

test("createBaseScopedFactory validates baseId and kind", () => {
  const state = {
    customBases: [{ id: "base-1", repo: "/repos/alpha", x: 10, y: 20, label: "Alpha" }],
    featureBuildings: [],
  } as Record<string, unknown>;

  assert.throws(
    () => createBaseScopedFactory(state, { baseId: "", kind: "feature" }),
    /baseId is required/
  );

  assert.throws(
    () => createBaseScopedFactory(state, { baseId: "base-1", kind: "warehouse" }),
    /kind must be one of/
  );

  assert.throws(
    () => createBaseScopedFactory(state, { baseId: "missing", kind: "feature" }),
    /baseId not found/
  );
});

test("createBaseScopedFactory links factory to requested base and tree groups it under same base", () => {
  const initialState = {
    customBases: [
      { id: "base-1", repo: "/repos/alpha", x: 10, y: 20, label: "Alpha" },
      { id: "base-2", repo: "/repos/alpha", x: 1000, y: 1000, label: "Beta" },
    ],
    featureBuildings: [],
    researchBuildings: [],
    warehouseBuildings: [],
  } as Record<string, unknown>;

  const created = createBaseScopedFactory(initialState, { baseId: "base-2", kind: "factory" });
  assert.equal(created.kind, "feature");
  assert.equal(created.baseId, "base-2");
  assert.ok(created.buildingId.startsWith("feature-"));

  const featureBuildings = created.state.featureBuildings as Array<Record<string, unknown>>;
  const inserted = featureBuildings.find((b) => String(b.id) === created.buildingId);
  assert.ok(inserted);
  assert.equal(inserted?.baseId, "base-2");
  assert.equal(inserted?.kind, "feature");

  const tree = buildMobileRtsTree(created.state);
  const targetBase = tree.bases.find((base) => base.id === "base-2");
  assert.ok(targetBase);
  const createdInTree = (targetBase?.buildings as Array<{ id: string }>).find((b) => b.id === created.buildingId);
  assert.ok(createdInTree);
});
