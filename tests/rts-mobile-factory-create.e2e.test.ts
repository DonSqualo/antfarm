import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 45000;
  const spread = 1500;
  return base + Math.floor(Math.random() * spread);
}

test("Mobile + creates a factory and starts a feature-dev run", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-rts-mobile-factory-"));
  const repoPath = path.join(tmpRoot, "fixture-antfarm");
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "fixture\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

  const port = pickPort();
  const server = startDashboard(port) as Server;
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Seed a base into layout DB so /api/rts/mobile/tree has a real baseId.
    const baseId = "base-alpha";
    const layoutResp = await fetch(`${baseUrl}/api/rts/layout/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entityType: "base",
        entityId: baseId,
        repoPath,
        x: 10,
        y: 20,
        payload: { id: baseId, label: "Alpha Base", repo: repoPath, x: 10, y: 20 },
      }),
    });
    assert.equal(layoutResp.ok, true, "Expected base layout upsert to succeed");

    const treeResp = await fetch(`${baseUrl}/api/rts/mobile/tree`);
    assert.equal(treeResp.ok, true, "Expected /api/rts/mobile/tree to succeed");
    const tree = (await treeResp.json()) as any;
    const bases = Array.isArray(tree?.bases) ? tree.bases : [];
    const base = bases.find((b: any) => String(b?.id || "") === baseId);
    assert.ok(base, "Expected seeded base to appear in mobile tree");

    const createResp = await fetch(`${baseUrl}/api/rts/factory/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseId, kind: "factory" }),
    });
    assert.equal(createResp.ok, true, "Expected /api/rts/factory/create to succeed");
    const createBody = (await createResp.json()) as any;
    assert.equal(createBody.ok, true);
    assert.equal(createBody.baseId, baseId);
    assert.ok(createBody.run?.id, "Expected factory create to return a run");
    assert.equal(String(createBody.run?.workflow_id || ""), "feature-dev");

    // Confirm the run is persisted and visible to the client.
    const runsResp = await fetch(`${baseUrl}/api/runs`);
    assert.equal(runsResp.ok, true, "Expected /api/runs to succeed");
    const runs = (await runsResp.json()) as any[];
    assert.ok(runs.some((r) => String(r?.id || "") === String(createBody.run.id)), "Expected created run to appear in /api/runs");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
