import fs from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function readDistOrSrc(distPath: string, srcPath: string): string {
  return fs.existsSync(distPath) ? readUtf8(distPath) : readUtf8(srcPath);
}

function run(): void {
  const repoRoot = process.cwd();
  const srcHtmlPath = path.join(repoRoot, "src/server/rts.html");
  const distHtmlPath = path.join(repoRoot, "dist/server/rts.html");

  const srcHtml = readUtf8(srcHtmlPath);
  const distHtml = readDistOrSrc(distHtmlPath, srcHtmlPath);

  for (const [label, html] of [["src", srcHtml], ["dist", distHtml]] as const) {
    assert(!html.includes("id=\"assignmentRows\""), `${label}: editable assignment rows still rendered`);
    assert(!html.includes("id=\"autoAssignBtn\""), `${label}: auto-assign button still rendered`);

    assert(html.includes("id=\"assignedAgentList\""), `${label}: assigned-agent status list missing`);
    assert(html.includes("function deriveRunAgents(run)"), `${label}: run agent derivation helper missing`);
    assert(html.includes("renderAgentStatusList(deriveRunAgents(run), run)"), `${label}: post-launch assigned-agent rendering missing`);
  }

  console.log("PASS: Assignment editing UI removed while automatic launch assignments and read-only assigned-agent visibility remain.");
}

run();
