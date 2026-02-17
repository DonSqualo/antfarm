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
  test(`RTS world interactions guard against native text selection (${t.label})`, () => {
    const body = readText(t.rel);

    // Scoped CSS: disable selection only inside the interactive world container.
    assert.match(body, /\.world-wrap\s*\{[^}]*user-select\s*:\s*none\s*;[^}]*\}/s);
    assert.match(body, /\.world-wrap\s*\{[^}]*-webkit-user-select\s*:\s*none\s*;[^}]*\}/s);

    // Pointer/mouse drags should prevent default to avoid selection on text-like children.
    // (Base drag handler)
    assert.match(body, /type:\s*'base'[\s\S]*?el\.onmousedown\s*=\s*\(e\)\s*=>\s*\{[\s\S]*?e\.preventDefault\(\)\s*;[\s\S]*?state\.draggingEntity\s*=\s*\{[\s\S]*?type:\s*'base'/);

    // (Base draft drag handler)
    assert.match(body, /type:\s*'baseDraft'[\s\S]*?e\.preventDefault\(\)\s*;[\s\S]*?state\.draggingEntity\s*=\s*\{[\s\S]*?type:\s*'baseDraft'/);

    // (Building drag handler)
    assert.match(body, /state\.buildings\.forEach[\s\S]*?el\.onmousedown\s*=\s*\(e\)\s*=>\s*\{[\s\S]*?e\.preventDefault\(\)\s*;[\s\S]*?state\.draggingEntity\s*=\s*\{/);
  });
}
