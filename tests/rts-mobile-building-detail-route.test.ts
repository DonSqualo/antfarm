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
    assert(html.includes("function getMobileBuildingRouteId(){"), `${label}: route parser for building detail is missing`);
    assert(html.includes("window.location.hash = nextHash;"), `${label}: selecting a building should navigate using URL hash`);
    assert(html.includes('data-mobile-building-id="${esc(buildingId)}"'), `${label}: building rows must include selectable building id route target`);
    assert(html.includes("data-mobile-list-back=\"1\""), `${label}: detail screen back navigation control missing`);
    assert(html.includes("Building not found for ID:"), `${label}: deterministic not-found detail state missing`);
    assert(html.includes("const buildingBtn = target?.closest('[data-mobile-building-id]');"), `${label}: mobile list click handler missing building detail navigation`);
  }

  console.log("PASS: mobile building rows navigate to a detail route with back navigation and not-found handling.");
}

run();
