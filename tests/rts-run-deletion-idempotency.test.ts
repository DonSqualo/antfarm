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
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-rts-delete-"));
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
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'feature-dev', 'cleanup task', 'running', '{}', ?, ?)"
    ).run(runId, now, now);
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, created_at, updated_at) VALUES (?, ?, 1, 'US-X', 'x', 'x', '[]', 'pending', ?, ?)"
    ).run(crypto.randomUUID(), runId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'develop', 'developer', 1, 'x', 'STATUS: done', 'pending', ?, ?)"
    ).run(crypto.randomUUID(), runId, now, now);
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'run', ?, '/tmp/repo', '/tmp/repo/worktrees/demo', 1, 2, '{}', ?)"
    ).run(`run:${runId}`, runId, now);

    const initialState = {
      featureBuildings: [{ id: `feature-${runId}`, runId, x: 7, y: 8 }],
      runLayoutOverrides: { [runId]: { x: 11, y: 12 } },
      selected: { type: "building", data: { id: `run:${runId}`, runId } },
      customBases: [],
    };
    db.prepare("INSERT INTO rts_state (id, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(JSON.stringify(initialState), now);

    const firstDelete = await requestJson(port, "POST", "/api/rts/building/delete", { runId });
    assert.equal(firstDelete.ok, true);
    assert.equal(firstDelete.deleted, true);

    const stateAfterFirstDelete = await requestJson(port, "GET", "/api/rts/state");
    assert.equal(stateAfterFirstDelete.ok, true);
    assert.equal(stateAfterFirstDelete.state.runLayoutOverrides?.[runId], undefined);
    assert.equal(stateAfterFirstDelete.state.selected ?? null, null);
    assert.equal((stateAfterFirstDelete.state.featureBuildings || []).filter((b: any) => b.runId === runId).length, 0);

    const secondDelete = await requestJson(port, "POST", "/api/rts/building/delete", { runId });
    assert.equal(secondDelete.ok, true);
    assert.equal(secondDelete.alreadyAbsent, true);

    const runRow = db.prepare("SELECT id FROM runs WHERE id = ?").get(runId) as { id: string } | undefined;
    assert.equal(runRow, undefined);

    const prefixedRunId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'feature-dev', 'cleanup task 2', 'running', '{}', ?, ?)"
    ).run(prefixedRunId, now, now);
    db.prepare("INSERT INTO rts_state (id, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(
      JSON.stringify({
        featureBuildings: [{ id: `feature-${prefixedRunId}`, runId: prefixedRunId, x: 3, y: 4 }],
        runLayoutOverrides: { [prefixedRunId]: { x: 2, y: 2 } },
        selected: { type: "building", data: { id: `run:${prefixedRunId}`, runId: prefixedRunId } },
        customBases: [],
      }),
      now
    );

    const prefixDelete = await requestJson(port, "POST", "/api/rts/building/delete", { runId: prefixedRunId.slice(0, 8) });
    assert.equal(prefixDelete.ok, true);
    assert.equal(prefixDelete.deleted, true);

    const stateAfterPrefixDelete = await requestJson(port, "GET", "/api/rts/state");
    assert.equal(stateAfterPrefixDelete.state.runLayoutOverrides?.[prefixedRunId], undefined);
    assert.equal(stateAfterPrefixDelete.state.selected ?? null, null);
    assert.equal((stateAfterPrefixDelete.state.featureBuildings || []).filter((b: any) => b.runId === prefixedRunId).length, 0);

    const unrelatedRunId = crypto.randomUUID();
    db.prepare("INSERT INTO rts_state (id, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at").run(
      JSON.stringify({
        featureBuildings: [{ id: `feature-${unrelatedRunId}`, runId: unrelatedRunId, x: 9, y: 9 }],
        runLayoutOverrides: { [unrelatedRunId]: { x: 5, y: 6 } },
        selected: { type: "building", data: { id: `run:${unrelatedRunId}`, runId: unrelatedRunId } },
        customBases: [],
      }),
      now
    );
    db.prepare(
      "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) VALUES (?, 'run', ?, '/tmp/repo', '/tmp/repo/worktrees/unrelated', 10, 10, '{}', ?)"
    ).run(`run:${unrelatedRunId}`, unrelatedRunId, now);

    const beforeUnknownState = (db.prepare("SELECT state_json FROM rts_state WHERE id = 1").get() as { state_json: string }).state_json;
    const beforeUnknownCount = Number((db.prepare("SELECT COUNT(*) AS c FROM rts_layout_entities").get() as { c: number }).c);

    const unknownDelete = await requestJson(port, "POST", "/api/rts/building/delete", { runId: "missing-run-id" });
    assert.equal(unknownDelete.ok, true);
    assert.equal(unknownDelete.deleted, false);
    assert.equal(unknownDelete.alreadyAbsent, true);

    const afterUnknownState = (db.prepare("SELECT state_json FROM rts_state WHERE id = 1").get() as { state_json: string }).state_json;
    const afterUnknownCount = Number((db.prepare("SELECT COUNT(*) AS c FROM rts_layout_entities").get() as { c: number }).c);

    assert.equal(afterUnknownState, beforeUnknownState);
    assert.equal(afterUnknownCount, beforeUnknownCount);
  });

  console.log("rts run deletion and purge idempotency tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
