/**
 * Tests for the view transpiler.
 *
 * Run: node --test design/scripts/dc-to-view.test.mjs
 *
 * The fixture mirrors the shapes in BusinessOS's "Sales.dc.html": a screen root
 * carrying data-screen-label, a <header> with an <img src="comet.png">, sc-if,
 * sc-for with a loop variable, style-hover, an onClick binding, a ref binding,
 * an entity in text and a boolean attribute. The three contracts the tool
 * asserts at run time are exercised here on a file whose output can be read
 * end to end, and the CLI's --check is proven to fail loudly on a stale file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateView, runView } from './dc-to-view.mjs';

const TOOL = fileURLToPath(new URL('./dc-to-view.mjs', import.meta.url));

const FIXTURE = `<!DOCTYPE html>
<html>
<body>
<x-dc>
<div data-screen-label="Demo" class="root" style="display:flex;gap:{{ gap }}px">
  <header style="color:#fff;height:48px">
    <img src="logo.png" alt="" style="width:26px;height:26px">
    <span>{{ title }}</span>
  </header>
  <sc-if value="{{ open }}">
    <p style="margin:0" style-hover="background:rgba(255,255,255,.12)">Hi &amp; bye</p>
  </sc-if>
  <sc-for list="{{ rows }}" as="r" hint-placeholder-count="3">
    <div onClick="{{ r.pick }}" style="padding:4px">{{ r.name }}</div>
  </sc-for>
  <input ref="{{ box }}" disabled style="border:0">
</div>
</x-dc>
</body>
</html>
`;

/** A throwaway repo: out/ holds the generated files, out/design/ the pull. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'dc-to-view-'));
  mkdirSync(join(root, 'out', 'design'), { recursive: true });
  writeFileSync(join(root, 'out', 'design', 'Demo.dc.html'), FIXTURE);
  writeFileSync(join(root, 'out', 'design', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}
const SCREEN = { name: 'Demo', entry: 'Demo.dc.html', designDir: 'out/design', outDir: 'out', header: true };

test('emits the view, both bindings files and the header', () => {
  const root = repo();
  const files = generateView(SCREEN, root);
  const names = files.map(([p]) => p.slice(root.length + 1)).sort();
  assert.deepEqual(names, [
    'out/DemoHeaderView.tsx',
    'out/DemoScreenView.tsx',
    'out/bindings.generated.ts',
    'out/bindings.inert.generated.ts',
  ]);
});

test('every style string survives verbatim and the view is a pure function of v', () => {
  const root = repo();
  const view = generateView(SCREEN, root).find(([p]) => p.endsWith('DemoScreenView.tsx'))[1];
  assert.match(view, /export function DemoScreenView\(\{ v \}: \{ v: DemoBindings \}\)/);
  for (const css of ['color:#fff;height:48px', 'width:26px;height:26px', 'margin:0', 'padding:4px', 'border:0']) {
    assert.ok(view.includes(`dcStyle(\`${css}\`)`), `style kept: ${css}`);
  }
  assert.ok(view.includes('dcStyle(`display:flex;gap:${v.gap}px`)'), 'a bound style becomes a template literal');
  assert.ok(view.includes('dcState(`background:rgba(255,255,255,.12)`, "hover")'), 'style-hover becomes dcState');
  assert.ok(view.includes('{v.open ? ('), 'sc-if becomes a ternary');
  assert.ok(view.includes('dcList(v.rows).map((r, r__i) =>'), 'sc-for becomes dcList().map');
  assert.ok(view.includes('onClick={r.pick}'), 'a loop variable stays local, not v.r');
  assert.ok(view.includes('{"Hi & bye"}'), 'entities decode in text');
  assert.ok(view.includes('<input ref={v.box} disabled style='), 'a bare boolean attribute stays bare');
  assert.ok(!view.includes('hint-placeholder'), 'editor-only hints are dropped');
});

test('assets become module imports named from the file, in the file that uses them', () => {
  const root = repo();
  const files = Object.fromEntries(generateView(SCREEN, root).map(([p, c]) => [p.split('/').pop(), c]));
  assert.ok(files['DemoScreenView.tsx'].includes("import logoPng from './design/logo.png';"));
  assert.ok(files['DemoScreenView.tsx'].includes('src={logoPng}'));
  assert.ok(files['DemoHeaderView.tsx'].includes("import logoPng from './design/logo.png';"), 'the header imports its own asset');
  assert.ok(files['DemoHeaderView.tsx'].includes('export function DemoHeaderView'));
  assert.ok(!files['DemoHeaderView.tsx'].includes('sc-for'), 'the header file holds only the <header> subtree');
});

test('bindings are the set the markup reads, and inert defaults take the shape of their use', () => {
  const root = repo();
  const files = Object.fromEntries(generateView(SCREEN, root).map(([p, c]) => [p.split('/').pop(), c]));
  const b = files['bindings.generated.ts'];
  assert.ok(b.includes('export interface DemoBindings {'));
  for (const name of ['box', 'gap', 'open', 'rows', 'title']) assert.ok(b.includes(`  ${name}: any;`), name);
  assert.ok(!b.includes('  r: any;'), 'the loop variable is not a binding');
  assert.ok(b.includes('export const DEMO_BINDING_NAMES = [\n  "box",\n  "gap",\n  "open",\n  "rows",\n  "title"\n] as const;'));

  const inert = files['bindings.inert.generated.ts'];
  assert.ok(inert.includes('  rows: [],'), 'a list iterates');
  assert.ok(inert.includes('  open: false,'), 'a condition');
  assert.ok(inert.includes('  box: undefined,'), 'a ref');
  assert.ok(inert.includes("  gap: '',"), 'everything else is an empty string');
  assert.ok(inert.includes("  title: '',"));
});

test('only a screen that declares header emits a header view', () => {
  const root = repo();
  const names = generateView({ ...SCREEN, header: false }, root).map(([p]) => p.split('/').pop());
  assert.deepEqual(names.sort(), ['DemoScreenView.tsx', 'bindings.generated.ts', 'bindings.inert.generated.ts']);
});

test('names come off the screen name, and screenLabel picks the root when the design names it differently', () => {
  const root = repo();
  // The design file says data-screen-label="Demo"; the repo calls the screen ColdOutreach.
  const files = Object.fromEntries(
    generateView({ ...SCREEN, name: 'ColdOutreach', screenLabel: 'Demo' }, root).map(([p, c]) => [p.split('/').pop(), c]),
  );
  assert.ok('ColdOutreachScreenView.tsx' in files);
  assert.match(files['ColdOutreachScreenView.tsx'], /export function ColdOutreachScreenView\(\{ v \}: \{ v: ColdOutreachBindings \}\)/);
  assert.match(files['bindings.generated.ts'], /export const COLD_OUTREACH_BINDING_NAMES = /);
  assert.match(files['bindings.inert.generated.ts'], /The wiring in useColdOutreachBindings/);
  assert.throws(() => generateView({ ...SCREEN, name: 'Other' }, root), /screen root not found/);
});

test('the design folder must sit inside the out folder', () => {
  const root = repo();
  assert.throws(
    () => generateView({ ...SCREEN, designDir: 'elsewhere/design' }, root),
    /designDir elsewhere\/design must sit inside outDir out/,
  );
});

test('a missing <header> with --header is a hard stop', () => {
  const root = repo();
  writeFileSync(join(root, 'out', 'design', 'Demo.dc.html'), FIXTURE.replace(/<header[\s\S]*?<\/header>\n/, ''));
  assert.throws(() => generateView(SCREEN, root), /no <header> found/);
});

test('runView writes, then --check passes, then a hand edit makes --check fail', () => {
  const root = repo();
  runView(SCREEN, { root });
  assert.ok(existsSync(join(root, 'out', 'DemoScreenView.tsx')));

  const args = ['--design', 'out/design', '--entry', 'Demo.dc.html', '--out', 'out', '--name', 'Demo', '--header', '--check'];
  const ok = spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /round-trip OK/);
  assert.match(ok.stdout, /generated files up to date/);

  const p = join(root, 'out', 'bindings.generated.ts');
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// edited by hand\n');
  const stale = spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /generated file is stale/);
});

test('the CLI refuses to run without its four required flags', () => {
  const r = spawnSync(process.execPath, [TOOL, '--design', 'x', '--entry', 'y'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--name is required/);
});

test('a <dc-import> becomes an import<Name> slot binding the app fills', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'dcimp-'));
  mkdirSync(join(root, 'out/design'), { recursive: true });
  writeFileSync(join(root, 'out/design/A.dc.html'),
    '<x-dc>\n<div data-screen-label="A"><sc-if value="{{ isCash }}"><div><dc-import name="CashFlow" hint-size="100%,100%"></dc-import></div></sc-if></div>\n</x-dc>\n');
  const { generateView } = await import('./dc-to-view.mjs');
  const files = generateView({ name: 'A', entry: 'A.dc.html', designDir: 'out/design', outDir: 'out' }, root);
  const view = files.find(([p]) => p.endsWith('AScreenView.tsx'))[1];
  const bindings = files.find(([p]) => p.endsWith('bindings.generated.ts'))[1];
  assert.match(view, /\{v\.importCashFlow\}/);
  assert.match(bindings, /importCashFlow: any;/);
});

test('numeric attributes like rows are emitted as numbers, and --logic emits the logic class', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'dcnum-'));
  mkdirSync(join(root, 'out/design'), { recursive: true });
  writeFileSync(join(root, 'out/design/B.dc.html'),
    '<x-dc>\n<div data-screen-label="B"><textarea rows="7" maxlength="100"></textarea></div></x-dc>\n<script type="text/x-dc" data-dc-script>\nclass Component extends DCLogic { renderVals() { return { a: 1 }; } }\n</script>\n');
  const { generateView } = await import('./dc-to-view.mjs');
  const files = generateView({ name: 'B', entry: 'B.dc.html', designDir: 'out/design', outDir: 'out', logic: true }, root);
  const view = files.find(([p]) => p.endsWith('BScreenView.tsx'))[1];
  assert.match(view, /rows=\{7\}/);
  assert.match(view, /maxLength=\{100\}/);
  const logic = files.find(([p]) => p.endsWith('BLogic.generated.js'))[1];
  assert.match(logic, /class Component extends DCLogic/);
  assert.match(logic, /export default Component;/);
});

test('style-focus-within becomes a focus-within state rule', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'dcfw-'));
  mkdirSync(join(root, 'out/design'), { recursive: true });
  writeFileSync(join(root, 'out/design/C.dc.html'),
    '<x-dc>\n<div data-screen-label="C"><span style="color:red" style-focus-within="box-shadow:0 0 0 2px #8b1a2b"></span></div>\n</x-dc>\n');
  const { generateView } = await import('./dc-to-view.mjs');
  const view = generateView({ name: 'C', entry: 'C.dc.html', designDir: 'out/design', outDir: 'out' }, root)
    .find(([p]) => p.endsWith('CScreenView.tsx'))[1];
  assert.match(view, /dcState\(`box-shadow:0 0 0 2px #8b1a2b`, "focus-within"\)/);
});

/* ---------- the merge guard ------------------------------------------------ */

const MANIFEST_OF = (root) => JSON.parse(readFileSync(join(root, 'out', '_generated-manifest.json'), 'utf8'));

test('runView records a fingerprint for every file it writes, keyed by out-relative path', () => {
  const root = repo();
  const files = runView(SCREEN, { root });
  const m = MANIFEST_OF(root);
  assert.deepEqual(Object.keys(m.files).sort(), files.map(([p]) => p.slice(root.length + 1 + 'out/'.length)).sort());
});

test('a hand edit to a generated file blocks the next run and nothing is written', () => {
  const root = repo();
  runView(SCREEN, { root });
  const view = join(root, 'out', 'DemoScreenView.tsx');
  writeFileSync(view, '// hand edit\n');
  const design = join(root, 'out', 'design', 'Demo.dc.html');
  writeFileSync(design, readFileSync(design, 'utf8').replace('{{ title }}', '{{ title }}!'));
  assert.throws(() => runView(SCREEN, { root }), /--accept DemoScreenView\.tsx/);
  assert.equal(readFileSync(view, 'utf8'), '// hand edit\n');
});

test('accept lets the design win over the hand edit', () => {
  const root = repo();
  runView(SCREEN, { root });
  const view = join(root, 'out', 'DemoScreenView.tsx');
  writeFileSync(view, '// hand edit\n');
  runView(SCREEN, { root, accept: ['DemoScreenView.tsx'] });
  assert.notEqual(readFileSync(view, 'utf8'), '// hand edit\n');
});

test('generated files already on disk with no recorded fingerprints block the first guarded run', () => {
  const root = repo();
  runView(SCREEN, { root });
  writeFileSync(join(root, 'out', '_generated-manifest.json'), '{}');
  const design = join(root, 'out', 'design', 'Demo.dc.html');
  writeFileSync(design, readFileSync(design, 'utf8').replace('{{ title }}', '{{ title }}!'));
  assert.throws(() => runView(SCREEN, { root }), /no recorded fingerprint/);
});

test('the CLI passes --accept through', () => {
  const root = repo();
  runView(SCREEN, { root });
  writeFileSync(join(root, 'out', 'DemoScreenView.tsx'), '// hand edit\n');
  const args = [TOOL, '--name', 'Demo', '--entry', 'Demo.dc.html', '--design', 'out/design', '--out', 'out', '--header'];
  assert.equal(spawnSync(process.execPath, args, { cwd: root }).status, 1);
  assert.equal(spawnSync(process.execPath, [...args, '--accept', 'DemoScreenView.tsx'], { cwd: root }).status, 0);
});

test('an iframe allowfullscreen becomes React allowFullScreen, a boolean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dc-to-view-'));
  mkdirSync(join(root, 'out', 'design'), { recursive: true });
  writeFileSync(join(root, 'out', 'design', 'Demo.dc.html'), `<!DOCTYPE html><html><body><x-dc>
<div data-screen-label="Demo"><iframe src="{{ u }}" title="Grain" allowfullscreen="true" style="border:0"></iframe></div>
</x-dc></body></html>`);
  const files = generateView({ name: 'Demo', entry: 'Demo.dc.html', designDir: 'out/design', outDir: 'out' }, root);
  const view = files.find(([p]) => p.endsWith('DemoScreenView.tsx'))[1];
  assert.match(view, /allowFullScreen=\{true\}/);
  assert.doesNotMatch(view, /allowfullscreen=/);
});
