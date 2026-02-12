import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

async function withTempHome<T>(fn: (deps: { claimStep: (agentId: string) => any; completeStep: (stepId: string, output: string) => any; getDb: () => any }) => T | Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-step-ops-"));
  process.env.HOME = tempHome;

  try {
    const stepOps = await import("../dist/installer/step-ops.js");
    const dbModule = await import("../dist/db.js");
    return await fn({
      claimStep: stepOps.claimStep,
      completeStep: stepOps.completeStep,
      getDb: dbModule.getDb,
    });
  } finally {
    process.env.HOME = prevHome;
    // Intentionally do not remove tempHome here: async logger writes can occur
    // shortly after assertions, and deleting HOME races those writes.
  }
}

function seedRunAndStep(
  getDb: () => any,
  params: {
    runContext: string;
    stepType?: "single" | "loop";
    stepStatus?: "pending" | "running" | "waiting";
    loopConfig?: string | null;
    inputTemplate?: string;
    currentStoryId?: string | null;
  }
): { runId: string; stepId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', ?, datetime('now'), datetime('now'))"
  ).run(runId, params.runContext);

  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, loop_config, current_story_id, created_at, updated_at) VALUES (?, ?, 'dev-step', 'developer', 0, ?, 'STATUS', ?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(
    stepId,
    runId,
    params.inputTemplate ?? "Repo={{repo}} Missing={{missing_key}}",
    params.stepStatus ?? "pending",
    params.stepType ?? "single",
    params.loopConfig ?? null,
    params.currentStoryId ?? null,
  );

  return { runId, stepId };
}

async function run(): Promise<void> {
  await withTempHome(async ({ claimStep, completeStep, getDb }) => {
    // 1) claimStep: invalid runs.context JSON should not throw and should resolve with empty fallback context.
    {
      const { stepId } = seedRunAndStep(getDb, {
        runContext: "{invalid-json",
        inputTemplate: "Repo={{repo}} Missing={{missing_key}}",
      });
      const claimed = claimStep("developer");
      assert.equal(claimed.found, true);
      assert.equal(claimed.stepId, stepId);
      assert.match(claimed.resolvedInput, /Repo=\[missing: repo\]/);
      assert.match(claimed.resolvedInput, /Missing=\[missing: missing_key\]/);
    }

    // 2) completeStep: invalid existing runs.context should not throw and should persist parsed KEY: value output.
    {
      const { runId, stepId } = seedRunAndStep(getDb, {
        runContext: "{also-invalid",
        stepStatus: "running",
      });

      const result = completeStep(stepId, "STATUS: done\nCHANGES: updated parser");
      assert.deepEqual(result, { advanced: false, runCompleted: true });

      const db = getDb();
      const runRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const context = JSON.parse(runRow.context);
      assert.equal(context.status, "done");
      assert.equal(context.changes, "updated parser");
    }

    // 3) loop_config parsing: malformed or null loop_config should not throw in claim/complete paths.
    {
      const { stepId } = seedRunAndStep(getDb, {
        runContext: "{}",
        stepType: "loop",
        loopConfig: "{bad-loop-json",
      });
      const claimed = claimStep("developer");
      assert.equal(claimed.found, true);
      assert.equal(claimed.stepId, stepId);
    }

    {
      const db = getDb();
      const runId = crypto.randomUUID();
      const loopStepId = crypto.randomUUID();
      const storyId = crypto.randomUUID();

      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', datetime('now'), datetime('now'))"
      ).run(runId);

      db.prepare(
        "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-1', 'Story', 'Desc', '[]', 'running', 0, 2, datetime('now'), datetime('now'))"
      ).run(storyId, runId);

      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, loop_config, current_story_id, created_at, updated_at) VALUES (?, ?, 'loop-step', 'developer', 0, 'x', 'STATUS', 'running', 'loop', ?, ?, datetime('now'), datetime('now'))"
      ).run(loopStepId, runId, "{bad-loop-json", storyId);

      const result = completeStep(loopStepId, "STATUS: done");
      assert.equal(result.advanced, false);
      assert.equal(result.runCompleted, true);
    }
  });

  console.log("step context parsing regression tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
