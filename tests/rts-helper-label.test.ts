import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("RTS dashboard template does not contain Shift-drag/middle-mouse helper label", () => {
  const htmlPath = resolve(process.cwd(), "src/server/index.html");
  const html = readFileSync(htmlPath, "utf8");

  assert.equal(
    /Shift-drag\s+or\s+middle\s+mouse/i.test(html),
    false,
    "Expected helper phrase to be removed from shipped dashboard template",
  );

  assert.equal(
    /shift-?drag/i.test(html),
    false,
    "Expected no Shift-drag helper text in shipped dashboard template",
  );

  assert.equal(
    /middle\s+mouse/i.test(html),
    false,
    "Expected no middle-mouse helper text in shipped dashboard template",
  );
});
