import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStepVersionGate } from "./immediate-handoff.js";

describe("immediate handoff dedupe gate", () => {
  it("allows first kick per step version and suppresses duplicates", () => {
    const gate = createStepVersionGate();
    assert.equal(gate.shouldKick("step-1", "2026-02-12T10:00:00.000Z"), true);
    assert.equal(gate.shouldKick("step-1", "2026-02-12T10:00:00.000Z"), false);
  });

  it("allows kicking same step again when updated_at changes", () => {
    const gate = createStepVersionGate();
    assert.equal(gate.shouldKick("step-1", "2026-02-12T10:00:00.000Z"), true);
    assert.equal(gate.shouldKick("step-1", "2026-02-12T10:00:01.000Z"), true);
  });
});

