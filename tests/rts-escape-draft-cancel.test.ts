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
    assert(html.includes("function cancelActiveFeatureDraft()"), `${label}: cancelActiveFeatureDraft helper missing`);
    assert(html.includes("if (selected.data.committed || selected.data.runId) return false;"), `${label}: committed/run-backed draft guard missing`);
    assert(html.includes("state.featureBuildings = (state.featureBuildings || []).filter((b) => b.id !== selected.data.id);"), `${label}: draft removal from featureBuildings missing`);
    assert(html.includes("renderRunSetupPanel(null);"), `${label}: action panel reset missing after draft cancel`);

    assert(html.includes("if (e.key === 'Escape') {"), `${label}: Escape key handler block missing`);
    assert(html.includes("clearSelectedEntity();"), `${label}: Escape no longer clears active selection`);
    assert(html.includes("setPlacement(null);"), `${label}: Escape no longer cancels placement`);
  }

  console.log("PASS: Escape cancels active uncommitted feature draft flow and placement mode.");
}

run();
