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
    assert(
      html.includes("agenda: String(src.agenda || ''),"),
      `${label}: normalizeResearchBuilding does not default missing agenda to empty string`
    );
    assert(
      html.includes("researchBuildings: (Array.isArray(state.researchBuildings) ? state.researchBuildings : [])") &&
        html.includes(".map(normalizeResearchBuilding)"),
      `${label}: snapshotPersistableState does not persist normalized researchBuildings`
    );
    assert(
      html.includes("agenda: '',"),
      `${label}: placeResearchAt does not initialize agenda to empty string`
    );
  }

  console.log("PASS: Research Lab agenda defaults and persistence snapshot wiring are present in src and dist RTS HTML.");
}

run();
