import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

async function loadStartDashboard(): Promise<(port?: number) => import("node:http").Server> {
  const dashboard = await import("../dist/server/dashboard.js");
  return dashboard.startDashboard as (port?: number) => import("node:http").Server;
}

function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-research-api-"));
  execFileSync("git", ["init", dir], { stdio: "pipe" });
  return dir;
}

test("/api/rts/research/generate returns production plan entries without placeholder type", async (t) => {
  const startDashboard = await loadStartDashboard();
  const repoPath = createTempGitRepo();
  const server = startDashboard(0);
  t.after(() => {
    server.close();
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");

  const response = await fetch(`http://127.0.0.1:${addr.port}/api/rts/research/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: "Replace placeholder implementation with production behavior",
      repoPath,
      evidence: [
        { file: "src/server/dashboard.ts", line: 941, snippet: "// TODO: remove temporary branch" },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as { ok: boolean; plans: Array<{ type: string; prompt: string }>; error?: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.plans.length, 1);
  assert.ok(payload.plans[0]?.type === "feature" || payload.plans[0]?.type === "bug");
  assert.notEqual(payload.plans[0]?.type, "placeholder");
  assert.match(payload.plans[0]?.prompt ?? "", /Acceptance criteria:/);
});

test("/api/rts/research/generate returns deterministic error payload for invalid repo path", async (t) => {
  const startDashboard = await loadStartDashboard();
  const server = startDashboard(0);
  t.after(() => server.close());

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");

  const missingRepoPath = path.join(os.tmpdir(), "antfarm-missing-repo-path");
  const response = await fetch(`http://127.0.0.1:${addr.port}/api/rts/research/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: "Replace placeholder implementation with production behavior",
      repoPath: missingRepoPath,
      evidence: [],
    }),
  });

  assert.equal(response.status, 400);
  const payload = await response.json() as { ok: boolean; error: string; plans: unknown[] };
  assert.equal(payload.ok, false);
  assert.equal(payload.error, `Base repo path not found: ${missingRepoPath}`);
  assert.deepEqual(payload.plans, []);
});

test("rts html keeps generic error notice rendering without placeholder-specific UX markers", () => {
  const htmlPath = fs.existsSync(path.resolve(process.cwd(), "dist/server/rts.html"))
    ? path.resolve(process.cwd(), "dist/server/rts.html")
    : path.resolve(process.cwd(), "src/server/rts.html");
  const html = fs.readFileSync(htmlPath, "utf-8");

  assert.match(html, /mutationNotice\.textContent = `Error: \$\{err\.message \|\| err\}`;/);
  assert.doesNotMatch(html.toLowerCase(), /placeholder-specific/);
});
