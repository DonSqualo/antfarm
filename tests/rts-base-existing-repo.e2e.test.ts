import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 44000;
  const spread = 1500;
  return base + Math.floor(Math.random() * spread);
}

test("RTS base creation flow supports discovered local existing repos end-to-end", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-rts-local-repos-"));
  const repoPath = path.join(tmpRoot, "fixture-existing-repo");
  fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });

  const prevLocalRoots = process.env.ANTFARM_LOCAL_REPO_ROOTS;
  process.env.ANTFARM_LOCAL_REPO_ROOTS = tmpRoot;

  const port = pickPort();
  const server = startDashboard(port) as Server;
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const localReposResp = await fetch(`${baseUrl}/api/local-repos`);
    assert.equal(localReposResp.ok, true, "Expected /api/local-repos to succeed");
    const localRepos = (await localReposResp.json()) as Array<{ path: string; name: string }>;
    const discovered = localRepos.find((repo) => repo.path === repoPath);
    assert.ok(discovered, "Expected temp git repo fixture to be discoverable for New Base dropdown options");

    const createResp = await fetch(`${baseUrl}/api/rts/base/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useExistingRepoPath: repoPath, placement: { x: 12, y: 34 } }),
    });
    assert.equal(createResp.ok, true, "Expected existing-repo base create to succeed without clone URL");
    const createBody = (await createResp.json()) as { ok: boolean; mode?: string; repoPath?: string };
    assert.equal(createBody.ok, true);
    assert.equal(createBody.mode, "existing");
    assert.equal(createBody.repoPath, repoPath);

    const rtsHtml = await (await fetch(`${baseUrl}/rts`)).text();
    assert.ok(rtsHtml.includes("id=\"existingRepoSelect\""), "Expected New Base form to render existing repo dropdown control");
    assert.ok(rtsHtml.includes("useExistingRepoPath"), "Expected New Base submission flow to support existing-repo payload mode");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (prevLocalRoots === undefined) delete process.env.ANTFARM_LOCAL_REPO_ROOTS;
    else process.env.ANTFARM_LOCAL_REPO_ROOTS = prevLocalRoots;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
