import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readText(relPath: string) {
  const abs = path.join(repoRoot, relPath);
  assert.ok(fs.existsSync(abs), `Missing file: ${relPath}`);
  return fs.readFileSync(abs, 'utf8');
}

const targets = [
  { label: 'src', rel: 'src/server/rts.html' },
  { label: 'dist', rel: 'dist/server/rts.html' }
];

for (const t of targets) {
  test(`RTS entity pointer events are routed to entity shells (${t.label})`, () => {
    const body = readText(t.rel);

    // Entity shell should participate in hit-testing.
    assert.match(body, /\.entity\s*\{[^}]*pointer-events\s*:\s*auto\s*;[^}]*\}/s);

    // Disable hit-testing on inner iso wrapper so chips/progress text don't intercept.
    assert.match(body, /\.iso-core\s*\{[^}]*pointer-events\s*:\s*none\s*;[^}]*\}/s);

    // Building cursor should live on the shell (iso-core is non-interactive).
    assert.match(body, /\.building\s*\{[^}]*cursor\s*:\s*pointer\s*;[^}]*\}/s);
    assert.match(body, /\.building\.movable\s*\{[^}]*cursor\s*:\s*move\s*;[^}]*\}/s);

    // Guard: don't leave a pointer cursor on iso-core anymore (should inherit from shell).
    assert.doesNotMatch(body, /\.building\s+\.iso-core\s*\{[^}]*cursor\s*:\s*pointer\s*;[^}]*\}/s);

    // Selection wiring should be driven by entity shell click handler.
    assert.match(body, /state\.buildings\.forEach\(b\s*=>\s*\{[\s\S]*?onClick:\(\)\s*=>\s*\{[\s\S]*?state\.selected\s*=\s*\{\s*type:'building',\s*data:b\s*\}\s*;[\s\S]*?refreshSelectionVisuals\(\)\s*;[\s\S]*?\}\s*\}/);
  });
}
