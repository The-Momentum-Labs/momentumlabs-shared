/**
 * Tests for the shared manifest reader.
 * Run: node --test design/scripts/manifest.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, pullArgs, genArgs, splitManifestArgs } from './manifest.mjs';

const SALES = { name: 'Sales', project: 'p1', entry: 'Sales.dc.html', designDir: 'src/pages/sales/design', outDir: 'src/pages/sales', screenLabel: 'Sales', header: true, mode: 'view' };
const PORTAL = { name: 'Portal', project: 'p2', entry: 'App.dc.html', designDir: 'design/portal', outDir: 'src/portal/generated', mode: 'class', component: 'DesignApp', extra: ['a.css', 'b.js'], skip: ['x.png'] };

function manifest(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'manifest-')), 'design.config.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('loads every screen, or one by name', () => {
  const f = manifest({ screens: [SALES, PORTAL] });
  assert.deepEqual(loadManifest(f).map((s) => s.name), ['Sales', 'Portal']);
  assert.deepEqual(loadManifest(f, 'Portal').map((s) => s.name), ['Portal']);
  assert.throws(() => loadManifest(f, 'Nope'), /no screen named Nope/);
});

test('a missing required key or a bad mode is a hard stop', () => {
  assert.throws(() => loadManifest(manifest({ screens: [] })), /has no screens/);
  assert.throws(() => loadManifest(manifest({ screens: [{ ...SALES, outDir: undefined }] })), /Sales is missing "outDir"/);
  assert.throws(() => loadManifest(manifest({ screens: [{ ...SALES, mode: 'astro' }] })), /mode must be class or view/);
  // No default mode: class mode rebuilds outDir wholesale, and a forgotten key
  // once wiped src/pages/sales. The manifest has to say which mode it means.
  assert.throws(() => loadManifest(manifest({ screens: [{ ...SALES, mode: undefined }] })), /Sales is missing "mode"/);
});

test('pull flags: project, entry, out, plus extra and skip when present', () => {
  assert.deepEqual(pullArgs(SALES), ['--project', 'p1', '--entry', 'Sales.dc.html', '--out', 'src/pages/sales/design']);
  assert.deepEqual(pullArgs(PORTAL), ['--project', 'p2', '--entry', 'App.dc.html', '--out', 'design/portal', '--extra', 'a.css,b.js', '--skip', 'x.png']);
});

test('gen flags: view mode carries name, label and header; class mode carries component', () => {
  assert.deepEqual(genArgs(SALES), ['--design', 'src/pages/sales/design', '--entry', 'Sales.dc.html', '--out', 'src/pages/sales', '--mode', 'view', '--name', 'Sales', '--label', 'Sales', '--header']);
  assert.deepEqual(genArgs(PORTAL), ['--design', 'design/portal', '--entry', 'App.dc.html', '--out', 'src/portal/generated', '--mode', 'class', '--component', 'DesignApp']);
  assert.deepEqual(genArgs({ ...PORTAL, component: undefined }).slice(-2), ['--mode', 'class'], 'class mode without a component name leaves dc-gen its default');
});

test('--manifest and --screen come out of argv, everything else passes through', () => {
  assert.deepEqual(splitManifestArgs(['--manifest', 'design.config.json', '--check', '--screen', 'Sales', '--dry']), {
    manifest: 'design.config.json',
    only: 'Sales',
    rest: ['--check', '--dry'],
  });
  assert.deepEqual(splitManifestArgs(['--design', 'd']), { manifest: undefined, only: undefined, rest: ['--design', 'd'] });
});
