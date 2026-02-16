import test from "node:test";
import assert from "node:assert/strict";
import { buildMobileRtsTree } from "../dist/server/dashboard.js";

test("mobile tree groups buildings under persisted base linkage", () => {
  const tree = buildMobileRtsTree({
    customBases: [
      { id: "base-a", repo: "/repos/alpha", x: 0, y: 0, label: "Alpha Base" },
      { id: "base-b", repo: "/repos/alpha", x: 1000, y: 1000, label: "Alpha Outpost" },
    ],
    featureBuildings: [
      { id: "feature-1", kind: "feature", baseId: "base-b", repo: "/repos/alpha", label: "Factory 1", x: 5, y: 5 },
      { id: "feature-2", kind: "feature", repo: "/repos/alpha", worktreePath: "/repos/alpha/feature-near-a", x: 10, y: 10 },
    ],
    researchBuildings: [
      { id: "research-1", kind: "research", repo: "/repos/alpha", label: "Research Lab", x: 12, y: 12 },
    ],
    warehouseBuildings: [
      { id: "warehouse-1", kind: "warehouse", repo: "/repos/alpha", label: "Warehouse", x: 990, y: 990 },
    ],
  } as Record<string, unknown>);

  assert.equal(Array.isArray(tree.bases), true);

  const baseA = tree.bases.find((b) => b.id === "base-a");
  const baseB = tree.bases.find((b) => b.id === "base-b");
  assert.ok(baseA);
  assert.ok(baseB);

  assert.deepEqual(
    (baseB?.buildings as Array<{ id: string }>).map((b) => b.id).sort(),
    ["feature-1", "warehouse-1"].sort()
  );

  assert.deepEqual(
    (baseA?.buildings as Array<{ id: string }>).map((b) => b.id).sort(),
    ["feature-2", "research-1"].sort()
  );

  for (const base of tree.bases) {
    assert.equal(typeof base.id, "string");
    assert.equal(base.kind, "base");
    assert.equal(typeof base.label, "string");
    for (const building of base.buildings as Array<{ id: string; kind: string; label: string }>) {
      assert.equal(typeof building.id, "string");
      assert.ok(["feature", "research", "warehouse"].includes(building.kind));
      assert.equal(typeof building.label, "string");
    }
  }
});

test("mobile tree returns empty arrays for no-data state", () => {
  const tree = buildMobileRtsTree({} as Record<string, unknown>);
  assert.deepEqual(tree, { bases: [] });
});
