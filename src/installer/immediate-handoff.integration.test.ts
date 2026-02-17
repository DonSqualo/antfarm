import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emitEvent, onEvent } from "./events.js";
import { createImmediateHandoffHandler, createStepVersionGate, type StepRow } from "./immediate-handoff.js";

function waitForAsyncListeners(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("immediate handoff event integration", () => {
  it("kicks once per step version and re-kicks after updated_at changes", async () => {
    let step: StepRow = {
      id: "step-1",
      run_id: "run-1",
      status: "pending",
      updated_at: "2026-02-12T10:00:00.000Z",
      agent_id: "feature-dev_developer@run:run-1",
      workflow_id: "feature-dev",
      run_status: "running",
    };
    const kickedJobIds: string[] = [];
    const gate = createStepVersionGate();

    const handler = createImmediateHandoffHandler({
      selectStep: () => step,
      listCronJobs: async () => ({ ok: true, jobs: [{ id: "job-1", name: "antfarm/feature-dev/developer" }] }),
      runCronJobNow: async (jobId: string) => {
        kickedJobIds.push(jobId);
        return { ok: true };
      },
      shouldKick: gate.shouldKick,
      inFlight: new Set<string>(),
      logInfo: async () => {},
      logWarn: async () => {},
    });

    const off = onEvent((evt) => void handler(evt));
    try {
      emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId: "run-1", workflowId: "feature-dev", stepId: "step-1" });
      await waitForAsyncListeners();
      emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId: "run-1", workflowId: "feature-dev", stepId: "step-1" });
      await waitForAsyncListeners();

      assert.equal(kickedJobIds.length, 1);
      assert.equal(kickedJobIds[0], "job-1");

      step = { ...step, updated_at: "2026-02-12T10:00:01.000Z" };
      emitEvent({ ts: new Date().toISOString(), event: "step.pending", runId: "run-1", workflowId: "feature-dev", stepId: "step-1" });
      await waitForAsyncListeners();

      assert.equal(kickedJobIds.length, 2);
    } finally {
      off();
    }
  });
});
