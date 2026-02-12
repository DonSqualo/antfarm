import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchPrompt, generateResearchPlans } from "../src/server/research-plan.ts";

test("buildResearchPrompt keeps required structure and no placeholder-specific branch", () => {
  const prompt = buildResearchPrompt({
    type: "feature",
    task: "Replace placeholder implementations with production behavior",
    workflow: "feature-dev",
    repoPath: "/repo/path",
    goal: "Implement production behavior for findings.",
    evidence: ["src/server/dashboard.ts:60 if (!run) return null;"],
    deliverables: ["Implementation changes scoped to this task."],
    acceptanceCriteria: ["Tests cover success and failure paths."],
  });

  assert.match(prompt, /Task:/);
  assert.match(prompt, /Preferred workflow:/);
  assert.match(prompt, /Base repo path:/);
  assert.match(prompt, /Goal:/);
  assert.match(prompt, /Evidence:/);
  assert.match(prompt, /Expected deliverables:/);
  assert.match(prompt, /Acceptance criteria:/);
  assert.doesNotMatch(prompt.toLowerCase(), /placeholder logic is replaced with production-ready behavior\./);
});

test("generateResearchPlans keeps high-signal temporary markers and uses production plan types", () => {
  const plans = generateResearchPlans({
    task: "Replace placeholder implementations with production behavior",
    repoPath: "/repo/path",
    evidence: [
      { file: "src/server/dashboard.ts", line: 917, snippet: "type ResearchPlanType = \"feature\" | \"bug\" | \"placeholder\";" },
      { file: "src/server/dashboard.ts", line: 941, snippet: "// TODO: not implemented yet" },
    ],
  });

  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.ok(plan.type === "feature" || plan.type === "bug");
    assert.notEqual(plan.type, "placeholder" as never);
    assert.ok(plan.acceptanceCriteria.length > 0);
    assert.doesNotMatch(plan.acceptanceCriteria.join(" ").toLowerCase(), /placeholder-only/);
  }
});

test("generateResearchPlans ignores generic null-return evidence and keeps bug markers", () => {
  const plans = generateResearchPlans({
    task: "Replace placeholder implementations with production behavior",
    repoPath: "/repo/path",
    evidence: [
      { file: "src/server/dashboard.ts", line: 60, snippet: "return null;" },
      { file: "src/server/dashboard.ts", line: 61, snippet: "// NYI: proper validation path" },
      { file: "src/server/dashboard.ts", line: 62, snippet: "// placeholder bug branch" },
    ],
  });

  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((plan) => plan.evidence[0]), [
    "src/server/dashboard.ts:61 // NYI: proper validation path",
    "src/server/dashboard.ts:62 // placeholder bug branch",
  ]);
  assert.equal(plans[0]?.type, "feature");
  assert.equal(plans[1]?.type, "bug");
  assert.equal(plans[1]?.workflow, "bug-fix");
});

test("generateResearchPlans handles empty evidence", () => {
  const emptyPlans = generateResearchPlans({
    task: "No evidence",
    repoPath: "/repo/path",
    evidence: [],
  });
  assert.deepEqual(emptyPlans, []);
});
