import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";

function requestJson(port: number, method: "GET" | "POST", route: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": String(payload.length),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8") || "{}";
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withDashboard<T>(fn: (deps: { db: any; port: number }) => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-rts-layout-"));
  process.env.HOME = tempHome;

  const { getDb } = await import("../dist/db.js");
  const { startDashboard } = await import("../dist/server/dashboard.js");

  const server = startDashboard(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? Number(addr.port) : 0;

  try {
    const db = getDb();
    await requestJson(port, "GET", "/api/rts/state");
    return await fn({ db, port });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = prevHome;
  }
}

async function run(): Promise<void> {
  await withDashboard(async ({ db, port }) => {
    const now = new Date().toISOString();

    // 1) Null/empty path rows should not break hydration.
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'feature', NULL, NULL, NULL, 10, 20, '{}', ?)"
    ).run("feature-null-path", now);

    const nullPathState = await requestJson(port, "GET", "/api/rts/state");
    assert.equal(nullPathState.ok, true);
    assert.ok(Array.isArray(nullPathState.state.featureBuildings));

    // 2) Equivalent relative/absolute worktrees should dedupe to one logical feature.
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'feature', NULL, ?, ?, 1, 1, '{}', ?)"
    ).run("feature-rel", "/tmp/repo", "./worktrees/demo", now);
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'feature', NULL, ?, ?, 2, 2, '{}', ?)"
    ).run("feature-abs", "/tmp/repo/", "/tmp/repo/worktrees/demo", now);

    const dedupedState = await requestJson(port, "GET", "/api/rts/state");
    const dedupedMatches = (dedupedState.state.featureBuildings as Array<any>).filter(
      (f) => String(f.worktreePath) === "/tmp/repo/worktrees/demo"
    );
    assert.equal(dedupedMatches.length, 1);

    // 3) Stale run_id references should reconcile and avoid duplicate feature entries.
    const liveRunId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'feature-dev', 'task', 'running', ?, datetime('now'), datetime('now'))"
    ).run(liveRunId, JSON.stringify({ baseRepoPath: "/tmp/repo", worktreePath: "worktrees/stale-demo" }));

    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'feature', ?, ?, ?, 3, 3, '{}', ?)"
    ).run("feature-stale-a", "deleted-run-id", "/tmp/repo", "worktrees/stale-demo", now);
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'feature', NULL, ?, ?, 4, 4, '{}', ?)"
    ).run("feature-stale-b", "/tmp/repo", "/tmp/repo/worktrees/stale-demo", now);

    const reconciledState = await requestJson(port, "GET", "/api/rts/state");
    const staleMatches = (reconciledState.state.featureBuildings as Array<any>).filter(
      (f) => String(f.worktreePath) === "/tmp/repo/worktrees/stale-demo"
    );
    assert.equal(staleMatches.length, 1);
    assert.equal(staleMatches[0].runId, liveRunId);

    const staleRows = db.prepare("SELECT COUNT(*) AS c FROM rts_layout_entities WHERE run_id = 'deleted-run-id'").get() as { c: number };
    assert.equal(Number(staleRows.c), 0);

    // 4) upsert path handling must accept missing repo/worktree values without throwing.
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'feature', NULL, NULL, NULL, 7, 8, '{}', ?)"
    ).run("feature-upsert-missing", now);

    const saved = await requestJson(port, "POST", "/api/rts/state", {
      state: {
        featureBuildings: [{ id: "feature-upsert-missing", x: 12, y: 13, committed: false }],
      },
    });
    assert.equal(saved.ok, true);
  });

  console.log("rts layout null-path and stale-run reconciliation tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
