import fs from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function run(): void {
  const repoRoot = process.cwd();
  const srcHtmlPath = path.join(repoRoot, "src/server/rts.html");
  const distHtmlPath = path.join(repoRoot, "dist/server/rts.html");

  const srcHtml = readUtf8(srcHtmlPath);
  const distHtml = readUtf8(distHtmlPath);

  for (const [label, html] of [["src", srcHtml], ["dist", distHtml]] as const) {
    assert(!html.includes("id=\"assignmentRows\""), `${label}: editable assignment rows still rendered`);
    assert(!html.includes("id=\"autoAssignBtn\""), `${label}: auto-assign button still rendered`);

    // Current RTS uses base-scoped worker pool allocation + per-draft workerAssignments map.
    assert(html.includes("allocateWorkersForBase(resolvedBase, 'feature-dev')"), `${label}: base-scoped worker allocation missing`);
    assert(html.includes("const fallbackAssignments = {};"), `${label}: fallback worker assignment map missing`);
    assert(html.includes("fallbackAssignments[role] = `${role}-1`;"), `${label}: fallback assignment naming missing`);
    assert(html.includes("draft.workerAssignments = { ...fallbackAssignments, ...allocation.assignments, ...(draft.workerAssignments || {}) };"), `${label}: launch does not merge automatic worker assignments`);

    assert(html.includes("renderAgentStatusList(runAgents, run)"), `${label}: post-launch assigned-agent status list missing`);
  }

  console.log("PASS: Assignment editing UI removed while automatic launch assignments and read-only assigned-agent visibility remain.");
}

run();
