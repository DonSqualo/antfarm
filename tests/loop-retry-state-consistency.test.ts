import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function withTempHome<T>(
  fn: (deps: {
    claimStep: (agentId: string) => any;
    completeStep: (stepId: string, output: string) => any;
    failStep: (stepId: string, error: string) => any;
    getDb: () => any;
  }) => T | Promise<T>
): Promise<T> {
  const previousHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-loop-retry-"));
  process.env.HOME = tempHome;

  try {
    const stepOps = await import("../dist/installer/step-ops.js");
    const dbModule = await import("../dist/db.js");

    return await fn({
      claimStep: stepOps.claimStep,
      completeStep: stepOps.completeStep,
      failStep: stepOps.failStep,
      getDb: dbModule.getDb,
    });
  } finally {
    process.env.HOME = previousHome;
  }
}

function insertRun(getDb: () => any): string {
  const db = getDb();
  const runId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', datetime('now'), datetime('now'))"
  ).run(runId);
  return runId;
}

async function run(): Promise<void> {
  await withTempHome(async ({ claimStep, completeStep, failStep, getDb }) => {
    // 1) Abandoned running loop story below retry limit is reset consistently.
    {
      const db = getDb();
      const runId = insertRun(getDb);
      const storyId = crypto.randomUUID();
      const loopStepId = crypto.randomUUID();

      db.prepare(
        "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-1', 'Story', 'Desc', '[]', 'running', 0, 2, datetime('now'), datetime('now', '-20 minutes'))"
      ).run(storyId, runId);

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, loop_config, current_story_id, created_at, updated_at) VALUES (?, ?, 'loop-step', 'developer', 0, 'x', 'STATUS', 'running', 'loop', ?, ?, datetime('now'), datetime('now', '-20 minutes'))"
      ).run(loopStepId, runId, '{"over":"stories"}', storyId);

      const claim = claimStep("unrelated-agent");
      assert.equal(claim.found, false);

      const story = db.prepare("SELECT status, retry_count FROM stories WHERE id = ?").get(storyId) as { status: string; retry_count: number };
      const step = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(loopStepId) as { status: string; current_story_id: string | null };

      assert.equal(story.status, "pending");
      assert.equal(story.retry_count, 1);
      assert.equal(step.status, "pending");
      assert.equal(step.current_story_id, null);
    }

    // 2) Loop retry exhaustion via failStep fails story, loop step, and run.
    {
      const db = getDb();
      const runId = insertRun(getDb);
      const storyId = crypto.randomUUID();
      const loopStepId = crypto.randomUUID();

      db.prepare(
        "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-2', 'Story', 'Desc', '[]', 'running', 2, 2, datetime('now'), datetime('now'))"
      ).run(storyId, runId);

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, loop_config, current_story_id, created_at, updated_at) VALUES (?, ?, 'loop-step', 'developer', 0, 'x', 'STATUS', 'running', 'loop', ?, ?, datetime('now'), datetime('now'))"
      ).run(loopStepId, runId, '{"over":"stories"}', storyId);

      const result = failStep(loopStepId, "loop error");
      assert.deepEqual(result, { retrying: false, runFailed: true });

      const story = db.prepare("SELECT status, retry_count FROM stories WHERE id = ?").get(storyId) as { status: string; retry_count: number };
      const step = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(loopStepId) as { status: string; current_story_id: string | null };
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };

      assert.equal(story.status, "failed");
      assert.equal(story.retry_count, 3);
      assert.equal(step.status, "failed");
      assert.equal(step.current_story_id, null);
      assert.equal(run.status, "failed");
    }

    // 3) verify-each STATUS: retry re-queues loop + story and stores feedback.
    {
      const db = getDb();
      const runId = insertRun(getDb);
      const storyId = crypto.randomUUID();
      const loopStepId = crypto.randomUUID();
      const verifyStepId = crypto.randomUUID();

      db.prepare(
        "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-3', 'Story', 'Desc', '[]', 'done', 0, 2, datetime('now'), datetime('now'))"
      ).run(storyId, runId);

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, loop_config, current_story_id, created_at, updated_at) VALUES (?, ?, 'loop-step', 'developer', 0, 'x', 'STATUS', 'running', 'loop', ?, NULL, datetime('now'), datetime('now'))"
      ).run(loopStepId, runId, '{"over":"stories","verifyEach":true,"verifyStep":"verify"}');

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, loop_config, current_story_id, created_at, updated_at) VALUES (?, ?, 'verify', 'verifier', 1, 'x', 'STATUS', 'running', 'single', NULL, NULL, datetime('now'), datetime('now'))"
      ).run(verifyStepId, runId);

      const result = completeStep(verifyStepId, "STATUS: retry\nISSUES: needs fixes");
      assert.deepEqual(result, { advanced: false, runCompleted: false });

      const story = db.prepare("SELECT status, retry_count FROM stories WHERE id = ?").get(storyId) as { status: string; retry_count: number };
      const loopStep = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(loopStepId) as { status: string; current_story_id: string | null };
      const verifyStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(verifyStepId) as { status: string };
      const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const context = JSON.parse(run.context) as Record<string, string>;

      assert.equal(story.status, "pending");
      assert.equal(story.retry_count, 1);
      assert.equal(loopStep.status, "pending");
      assert.equal(loopStep.current_story_id, null);
      assert.equal(verifyStep.status, "waiting");
      assert.equal(context.verify_feedback, "needs fixes");
    }
  });

  console.log("loop retry state consistency tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
