import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 46050;
  const spread = 800;
  return base + Math.floor(Math.random() * spread);
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("RTS refresh keeps disconnected base and warehouse entities after save/reload", async () => {
  const baseId = uniqueId("refresh-base");
  const warehouseId = uniqueId("refresh-warehouse");

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
        repoPath: "/tmp/disconnected-base-repo",
        x: 11,
        y: 22,
        payload: { id: baseId, repo: "/tmp/disconnected-base-repo", x: 11, y: 22, source: "custom" },
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
        repoPath: "/tmp/disconnected-warehouse-repo",
        worktreePath: "/tmp/disconnected-warehouse-repo",
        x: 33,
        y: 44,
        payload: { id: warehouseId, kind: "warehouse", repo: "/tmp/disconnected-warehouse-repo", x: 33, y: 44 },
      }),
    });
    assert.equal(createWarehouseResp.ok, true);

    const saveBeforeRefreshResp = await fetch(`${baseUrl}/api/rts/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoom: 1.1, featureBuildings: [] }),
    });
    assert.equal(saveBeforeRefreshResp.ok, true, "Expected pre-refresh snapshot save to succeed");

    const rtsPageResp = await fetch(`${baseUrl}/rts`);
    assert.equal(rtsPageResp.ok, true, "Expected RTS page load to succeed");

    const saveAfterRefreshResp = await fetch(`${baseUrl}/api/rts/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoom: 1.2, featureBuildings: [] }),
    });
    assert.equal(saveAfterRefreshResp.ok, true, "Expected post-refresh snapshot save to succeed");

    const stateResp = await fetch(`${baseUrl}/api/rts/state`);
    assert.equal(stateResp.ok, true);
    const payload = (await stateResp.json()) as {
      state?: {
        customBases?: Array<{ id?: string }>;
        warehouseBuildings?: Array<{ id?: string }>;
      };
    };

    assert.equal(
      (payload.state?.customBases || []).some((entry) => entry.id === baseId),
      true,
      "Expected disconnected base to persist across refresh save cycle"
    );

    assert.equal(
      (payload.state?.warehouseBuildings || []).some((entry) => entry.id === warehouseId),
      true,
      "Expected disconnected warehouse to persist across refresh save cycle"
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
