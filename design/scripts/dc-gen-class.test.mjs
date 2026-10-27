/**
 * Class mode's merge guard, through the dc-gen CLI.
 *
 * Run: node --test design/scripts/dc-gen-class.test.mjs
 *
 * Class mode owns its whole --out folder: a component deleted in Claude Design
 * must stop existing here too. It used to rmSync the folder first, which also
 * wiped any hand edit. Now it builds the new output beside the folder and only
 * swaps it in when the merge guard finds no hand edits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('./dc-gen.mjs', import.meta.url));

const APP = (title) => `<!DOCTYPE html>
<html>
<head><style>.a{color:red}</style></head>
<body>
<x-dc>
<div style="padding:4px"><span>{{ title }}</span></div>
</x-dc>
<script type="text/x-dc">
class Component extends DCLogic {
  renderVals() { return { title: '${title}' }; }
}
</script>
</body>
</html>
`;

function repo(title = 'One') {
  const root = mkdtempSync(join(tmpdir(), 'dc-gen-class-'));
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design', 'App.dc.html'), APP(title));
  return root;
}
const gen = (root, ...extra) =>
  spawnSync(process.execPath, [TOOL, '--design', 'design', '--out', 'gen', '--entry', 'App.dc.html', ...extra], { cwd: root, encoding: 'utf8' });
const redesign = (root, title) => writeFileSync(join(root, 'design', 'App.dc.html'), APP(title));

test('first run writes the output and records a fingerprint per file', () => {
  const root = repo();
  assert.equal(gen(root).status, 0);
  const m = JSON.parse(readFileSync(join(root, 'gen', '_generated-manifest.json'), 'utf8'));
  assert.ok(m.files['DesignApp.tsx']);
  assert.ok(m.files['design.css']);
  assert.equal(existsSync(join(root, 'gen.dcgen-stage')), false);
});

test('a re-run over untouched output picks up the design change', () => {
  const root = repo();
  gen(root);
  redesign(root, 'Two');
  assert.equal(gen(root).status, 0);
  assert.match(readFileSync(join(root, 'gen', 'DesignApp.tsx'), 'utf8'), /Two/);
});

test('a hand edit blocks the run and the whole folder is left as it was', () => {
  const root = repo();
  gen(root);
  writeFileSync(join(root, 'gen', 'DesignApp.tsx'), '// hand edit\n');
  redesign(root, 'Two');
  const r = gen(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--accept DesignApp\.tsx/);
  assert.equal(readFileSync(join(root, 'gen', 'DesignApp.tsx'), 'utf8'), '// hand edit\n');
  assert.equal(existsSync(join(root, 'gen.dcgen-stage')), false);
});

test('a hand written file dropped into the folder blocks the run instead of being deleted', () => {
  const root = repo();
  gen(root);
  writeFileSync(join(root, 'gen', 'Mine.tsx'), 'mine');
  assert.equal(gen(root).status, 1);
  assert.equal(readFileSync(join(root, 'gen', 'Mine.tsx'), 'utf8'), 'mine');
});

test('--accept lets the design win', () => {
  const root = repo();
  gen(root);
  writeFileSync(join(root, 'gen', 'DesignApp.tsx'), '// hand edit\n');
  redesign(root, 'Two');
  assert.equal(gen(root, '--accept', 'DesignApp.tsx').status, 0);
  assert.match(readFileSync(join(root, 'gen', 'DesignApp.tsx'), 'utf8'), /Two/);
});
