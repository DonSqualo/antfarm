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
      html.includes("<label for=\"researchAgendaInput\"") && html.includes("Current Agenda"),
      `${label}: Research Console does not render a labeled agenda textarea`
    );
    assert(
      html.includes("<textarea id=\"researchAgendaInput\"") && html.includes("${esc(String(lab.agenda || ''))}"),
      `${label}: Research Console agenda textarea is missing or not bound to lab.agenda`
    );
    assert(
      html.includes("agendaInput?.addEventListener('input', syncAgendaFromInput);") &&
        html.includes("agendaInput?.addEventListener('change', syncAgendaFromInput);"),
      `${label}: agenda textarea input/change handlers are not wired`
    );
    assert(
      html.includes("lab.agenda = nextAgenda;") && html.includes("queuePersist();"),
      `${label}: agenda updates are not persisted from textarea edits`
    );
  }

  console.log("PASS: Research Console agenda textarea renders and updates/persists selected lab agenda in src and dist RTS HTML.");
}

run();
