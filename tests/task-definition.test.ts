import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const taskDefinitionPath = resolve(process.cwd(), 'docs/task-definition.md');

test('docs/task-definition.md contains all required section headings', () => {
  const content = readFileSync(taskDefinitionPath, 'utf8');
  const requiredHeadings = [
    '## Objective',
    '## In Scope',
    '## Out of Scope',
    '## Constraints',
    '## Acceptance Checklist'
  ];

  for (const heading of requiredHeadings) {
    assert.match(content, new RegExp(`^${heading}$`, 'm'), `Missing required heading: ${heading}`);
  }
});
