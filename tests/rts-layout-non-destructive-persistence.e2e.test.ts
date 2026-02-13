import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 45500;
  const spread = 1000;
  return base + Math.floor(Math.random() * spread);
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("RTS state autosave does not prune base/warehouse rows when layout arrays are omitted", async () => {
  const baseId = uniqueId("base-test");
  const warehouseId = uniqueId("warehouse-test");

  const port = pickPort();
  const server = startDashboard(port) as Server;
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const createBaseResp = await fetch(`${baseUrl}/api/rts/layout/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType: "base",
        entityId: baseId,
        allowCreate: true,
        repoPath: "/tmp/example-base-repo",
        x: 10,
        y: 20,
        payload: { id: baseId, repo: "/tmp/example-base-repo", x: 10, y: 20, source: "custom" },
      }),
    });
    assert.equal(createBaseResp.ok, true);

    const createWarehouseResp = await fetch(`${baseUrl}/api/rts/layout/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType: "warehouse",
        entityId: warehouseId,
        allowCreate: true,
        repoPath: "/tmp/example-warehouse-repo",
        worktreePath: "/tmp/example-warehouse-repo",
        x: 30,
        y: 40,
        payload: { id: warehouseId, kind: "warehouse", repo: "/tmp/example-warehouse-repo", x: 30, y: 40 },
      }),
    });
    assert.equal(createWarehouseResp.ok, true);

    const saveResp = await fetch(`${baseUrl}/api/rts/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoom: 1.25, featureBuildings: [] }),
    });
    assert.equal(saveResp.ok, true, "Expected /api/rts/state save to succeed");

    const stateResp = await fetch(`${baseUrl}/api/rts/state`);
    assert.equal(stateResp.ok, true);
    const statePayload = (await stateResp.json()) as {
      state?: {
        customBases?: Array<{ id?: string }>;
        warehouseBuildings?: Array<{ id?: string }>;
      };
    };
    const savedState = statePayload.state || {};

    assert.equal(
      (savedState.customBases || []).some((entry) => entry.id === baseId),
      true,
      "Expected base row to persist when customBases is omitted from snapshot"
    );
    assert.equal(
      (savedState.warehouseBuildings || []).some((entry) => entry.id === warehouseId),
      true,
      "Expected warehouse row to persist when warehouseBuildings is omitted from snapshot"
    );

    const deleteBaseResp = await fetch(`${baseUrl}/api/rts/layout/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "base", entityId: baseId }),
    });
    const deleteBase = (await deleteBaseResp.json()) as { ok: boolean; deleted: boolean };
    assert.equal(deleteBaseResp.ok, true);
    assert.equal(deleteBase.ok, true);
    assert.equal(deleteBase.deleted, true, "Expected explicit base delete endpoint to remove targeted row");

    const deleteWarehouseResp = await fetch(`${baseUrl}/api/rts/layout/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "warehouse", entityId: warehouseId }),
    });
    const deleteWarehouse = (await deleteWarehouseResp.json()) as { ok: boolean; deleted: boolean };
    assert.equal(deleteWarehouseResp.ok, true);
    assert.equal(deleteWarehouse.ok, true);
    assert.equal(deleteWarehouse.deleted, true, "Expected explicit warehouse delete endpoint to remove targeted row");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
