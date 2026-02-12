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
    assert(html.includes("--z-world-entity-max:399;"), `${label}: world z ceiling token missing`);
    assert(html.includes("--z-ui-hud:600;"), `${label}: HUD z-index token missing`);
    assert(html.includes("--z-ui-command-bar:700;"), `${label}: command bar z-index token missing`);

    assert(html.includes(".world-wrap {") && html.includes("isolation:isolate;"), `${label}: world-wrap stacking context missing`);
    assert(html.includes(".hud {") && html.includes("z-index:var(--z-ui-hud);"), `${label}: HUD z-index contract missing`);
    assert(html.includes(".command-bar {") && html.includes("z-index:var(--z-ui-command-bar);"), `${label}: command bar z-index contract missing`);

    assert(html.includes("const WORLD_ENTITY_Z_MAX = 399;"), `${label}: world entity z ceiling constant missing`);
    assert(html.includes("Math.min(WORLD_ENTITY_Z_MAX, depth)"), `${label}: worldDepth does not clamp to ceiling`);

    assert(!html.includes("worldDepth(uy, 2000)"), `${label}: legacy high world z-bias still present`);
    assert(!html.includes("worldDepth(u.y, 2000)"), `${label}: legacy unit z-bias still present`);
    assert(!html.includes("worldDepth(sy, 1900)"), `${label}: legacy subunit z-bias still present`);
    assert(!html.includes("worldDepth(point.y, 1000)"), `${label}: legacy placement z-bias still present`);
  }

  console.log("PASS: RTS world/UI layering contract keeps world depth below UI z-index ceilings.");
}

run();
