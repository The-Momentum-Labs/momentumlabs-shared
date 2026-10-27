/**
 * Tests for the astro driver's own decisions.
 *
 * Run: node --test design/scripts/dc-gen-astro.test.mjs
 *
 * The converter is tested next door. What is tested here is the driver: which
 * files in a bundle count as pages, what url each is served at, and that a
 * skipped page still keeps its place in the route table.
 *
 * The file list below is the real contents of `momentumlabs/` in project
 * 3a7044d4, including `recruiting.v1.html`, which is a backup Nico keeps in the
 * project and which must never become a route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPages, routeFor, listFiles, vendorStylesheets } from './dc-gen-astro.mjs';

const REAL_BUNDLE = [
  '404.html', 'about.html', 'apple-touch-icon.png', 'careers.html', 'comet.png',
  'events.html', 'favicon-192.png', 'favicon-48.png', 'favicon-96.png',
  'favicon.ico', 'film.html', 'hero-poster.jpg', 'index.html', 'products.html',
  'recruiting.html', 'recruiting.v1.html', 'sitemap-index.xml', 'team.html',
];

/* ---------- discoverPages ------------------------------------------------ */

test('the nine real pages are found and nothing else', () => {
  assert.deepEqual(discoverPages(REAL_BUNDLE), [
    '404.html', 'about.html', 'careers.html', 'events.html', 'film.html',
    'index.html', 'products.html', 'recruiting.html', 'team.html',
  ]);
});

test('recruiting.v1.html is not a page', () => {
  assert.ok(!discoverPages(REAL_BUNDLE).includes('recruiting.v1.html'));
});

test('non-html files are not pages', () => {
  assert.deepEqual(discoverPages(['comet.png', 'site.css', 'sitemap-index.xml']), []);
});

test('the result is sorted, so a run is reproducible', () => {
  const a = discoverPages(['team.html', 'index.html', 'about.html']);
  assert.deepEqual(a, ['about.html', 'index.html', 'team.html']);
});

test('a page in a subfolder is a page, because the route has a slash in it', () => {
  // cypfounders.com serves /programs/brunch-events. A bundle that could only
  // hold flat files could never express that route, so the design would be
  // missing a page the site really has.
  const a = discoverPages([
    'index.html', 'programs/brunch-events.html', 'programs/speaker-events.html',
  ]);
  assert.deepEqual(a, [
    'index.html', 'programs/brunch-events.html', 'programs/speaker-events.html',
  ]);
});

test('a dotted stem is still a variant when it is nested', () => {
  assert.deepEqual(discoverPages(['programs/brunch-events.v1.html']), []);
});

/* ---------- routeFor ----------------------------------------------------- */

test('index is the site root and the rest drop the extension', () => {
  assert.equal(routeFor('index.html'), '/');
  assert.equal(routeFor('products.html'), '/products');
  assert.equal(routeFor('404.html'), '/404');
  assert.equal(routeFor('programs/brunch-events.html'), '/programs/brunch-events');
  // A folder's own index is that folder's route, not /programs/index, the same
  // way index.html at the top is / and not /index.
  assert.equal(routeFor('programs/index.html'), '/programs');
});

/* ---------- listFiles ---------------------------------------------------- */

test('listFiles walks nested directories and uses forward slashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-'));
  mkdirSync(join(root, 'fonts'));
  mkdirSync(join(root, 'site', 'logos'), { recursive: true });
  writeFileSync(join(root, 'comet.png'), 'x');
  writeFileSync(join(root, 'fonts', 'a.woff2'), 'x');
  writeFileSync(join(root, 'site', 'logos', 'mit.png'), 'x');
  assert.deepEqual(listFiles(root).sort(), [
    'comet.png', 'fonts/a.woff2', 'site/logos/mit.png',
  ]);
});

test('listFiles on a missing directory is empty, not a throw', () => {
  assert.deepEqual(listFiles(join(tmpdir(), 'definitely-not-here-' + Date.now())), []);
});

/* ---------- vendorStylesheets ------------------------------------------- */

test('a design stylesheet is copied and its import path is relative to the pages dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-'));
  const pagesDir = join(root, 'design', 'site', 'momentumlabs');
  mkdirSync(join(pagesDir, '_astro'), { recursive: true });
  writeFileSync(join(pagesDir, '_astro', 'careers.DbjjxZPV.css'), '.a{color:red}');

  const out = join(root, 'src', 'pages');
  mkdirSync(out, { recursive: true });

  const r = await vendorStylesheets({
    cfg: { stylesOut: join(root, 'src', 'styles', 'design'), styles: { careers: 'site.css' } },
    pagesDir,
    out,
    log: () => {},
  });

  assert.equal(r.importPaths.careers, './../styles/design/site.css');
  assert.equal(readFileSync(join(root, 'src', 'styles', 'design', 'site.css'), 'utf8'), '.a{color:red}');
});

test('the content hash never has to be written into the config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-'));
  const pagesDir = join(root, 'pages');
  mkdirSync(join(pagesDir, '_astro'), { recursive: true });
  // A different hash from the test above. The stem is what is looked up.
  writeFileSync(join(pagesDir, '_astro', 'careers.ZZZZZZZZ.css'), '.b{}');
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });

  const r = await vendorStylesheets({
    cfg: { stylesOut: join(root, 'styles'), styles: { careers: 'site.css' } },
    pagesDir, out, log: () => {},
  });
  assert.equal(r.copied.length, 1);
  assert.ok(existsSync(join(root, 'styles', 'site.css')));
});

test('a configured stylesheet missing from the bundle is reported, not invented', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-'));
  const pagesDir = join(root, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });

  const lines = [];
  const r = await vendorStylesheets({
    cfg: { stylesOut: join(root, 'styles'), styles: { careers: 'site.css' } },
    pagesDir, out, log: (m) => lines.push(m),
  });
  assert.equal(r.copied.length, 0);
  assert.equal(r.importPaths.careers, undefined);
  assert.ok(lines.join('\n').includes('careers'), lines.join('\n'));
});

test('no stylesOut means no vendoring and no crash', async () => {
  const r = await vendorStylesheets({ cfg: { styles: { careers: 'site.css' } }, pagesDir: '.', out: '.', log: () => {} });
  assert.deepEqual(r.importPaths, {});
  assert.deepEqual(r.copied, []);
});

test('a vendored stylesheet has its url() paths rewritten for its new home', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-'));
  const pagesDir = join(root, 'pages');
  mkdirSync(join(pagesDir, '_astro'), { recursive: true });
  writeFileSync(
    join(pagesDir, '_astro', 'careers.AAA.css'),
    "@font-face{src:url(../fonts/newsreader-latin.woff2) format('woff2')}",
  );
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });

  const r = await vendorStylesheets({
    cfg: { stylesOut: join(root, 'styles'), styles: { careers: 'site.css' } },
    pagesDir,
    out,
    publicFiles: new Set(['fonts/newsreader-latin.woff2']),
    log: () => {},
  });

  const css = readFileSync(join(root, 'styles', 'site.css'), 'utf8');
  assert.match(css, /url\(\/fonts\/newsreader-latin\.woff2\)/);
  assert.equal(r.copied[0].urlsRewritten, 1);
  assert.equal(r.unportable.length, 0);
});

test('a vendored stylesheet url with no match is reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-'));
  const pagesDir = join(root, 'pages');
  mkdirSync(join(pagesDir, '_astro'), { recursive: true });
  writeFileSync(join(pagesDir, '_astro', 'careers.AAA.css'), 'a{src:url(KaTeX.AAA.woff2)}');
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });

  const r = await vendorStylesheets({
    cfg: { stylesOut: join(root, 'styles'), styles: { careers: 'site.css' } },
    pagesDir, out, publicFiles: new Set(), log: () => {},
  });
  assert.equal(r.unportable.length, 1);
  // Inside _astro/ it is a build asset, so the miss is an asset-map miss. The
  // KaTeX fonts in the real base.css land here for exactly this reason.
  assert.match(r.unportable[0].reason, /no asset mapping for "KaTeX"/);
});

/* ---------- planWrites: the merge guard --------------------------------- */
/*
 * On 2026-10-16 design:gen copied the Claude Design recruiting page over a
 * hand-fixed src/pages/recruiting.astro and the real upload form was lost.
 * The generator now behaves like a three way merge: base is the sha256 it
 * recorded when it last wrote the file, ours is the file on disk, theirs is
 * the new output. A hand edit that the design does not already carry is a
 * conflict, and a conflict means nothing is written at all.
 */
import { planWrites, sha256, run } from './dc-gen-astro.mjs';

const H = (s) => sha256(s);

test('an untouched file is overwritten by the new design', () => {
  const r = planWrites({
    writes: [{ path: 'a.astro', body: 'NEW', current: 'OLD' }],
    base: { 'a.astro': H('OLD') },
  });
  assert.deepEqual(r.toWrite.map((w) => w.path), ['a.astro']);
  assert.deepEqual(r.conflicts, []);
});

test('a hand edited file whose design also changed is a conflict', () => {
  const r = planWrites({
    writes: [{ path: 'a.astro', body: 'NEW', current: 'HAND' }],
    base: { 'a.astro': H('OLD') },
  });
  assert.deepEqual(r.toWrite, []);
  assert.deepEqual(r.conflicts.map((c) => c.path), ['a.astro']);
});

test('a hand edited file the design already carries is left alone, not a conflict', () => {
  // Someone fixed the page by hand AND pushed the same fix into Claude Design.
  const r = planWrites({
    writes: [{ path: 'a.astro', body: 'HAND', current: 'HAND' }],
    base: { 'a.astro': H('OLD') },
  });
  assert.deepEqual(r.toWrite, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.unchanged, ['a.astro']);
});

test('a file with no recorded fingerprint is a conflict when it would change', () => {
  // The manifest predates the guard, or the file was never generated. There
  // is no way to prove nobody hand edited it, so it is not overwritten.
  const r = planWrites({
    writes: [{ path: 'a.astro', body: 'NEW', current: 'OLD' }],
    base: {},
  });
  assert.deepEqual(r.conflicts.map((c) => c.path), ['a.astro']);
  assert.match(r.conflicts[0].reason, /no recorded fingerprint/);
});

test('a brand new file is written; there is nothing on disk to protect', () => {
  const r = planWrites({
    writes: [{ path: 'new.astro', body: 'NEW', current: null }],
    base: {},
  });
  assert.deepEqual(r.toWrite.map((w) => w.path), ['new.astro']);
});

test('one conflict means nothing is written, not even the clean files', () => {
  const r = planWrites({
    writes: [
      { path: 'clean.astro', body: 'NEW', current: 'OLD' },
      { path: 'dirty.astro', body: 'NEW', current: 'HAND' },
    ],
    base: { 'clean.astro': H('OLD'), 'dirty.astro': H('OLD') },
  });
  assert.deepEqual(r.toWrite, []);
  assert.deepEqual(r.conflicts.map((c) => c.path), ['dirty.astro']);
  // The caller still needs to know what WOULD have been written, for the report.
  assert.deepEqual(r.blocked.map((w) => w.path), ['clean.astro']);
});

test('--accept overrides the conflict for the named files only', () => {
  const r = planWrites({
    writes: [
      { path: 'dirty.astro', body: 'NEW', current: 'HAND' },
      { path: 'other.astro', body: 'NEW', current: 'HAND' },
    ],
    base: { 'dirty.astro': H('OLD'), 'other.astro': H('OLD') },
    accept: ['dirty.astro'],
  });
  assert.deepEqual(r.conflicts.map((c) => c.path), ['other.astro']);
  assert.deepEqual(r.toWrite, []);
  const r2 = planWrites({
    writes: [{ path: 'dirty.astro', body: 'NEW', current: 'HAND' }],
    base: { 'dirty.astro': H('OLD') },
    accept: ['dirty.astro'],
  });
  assert.deepEqual(r2.toWrite.map((w) => w.path), ['dirty.astro']);
  assert.deepEqual(r2.conflicts, []);
});

/* ---------- run(): the guard end to end -------------------------------- */

const PAGE = (title, body) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>\n`;

function bundle() {
  const root = mkdtempSync(join(tmpdir(), 'dcgen-guard-'));
  const design = join(root, 'design', 'site');
  const pagesDir = join(design, 'ml');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, 'index.html'), PAGE('Home', '<p>home v1</p>'));
  writeFileSync(join(pagesDir, 'team.html'), PAGE('Team', '<p>team v1</p>'));
  const out = join(root, 'src', 'pages');
  const publicDir = join(root, 'public');
  mkdirSync(publicDir, { recursive: true });
  return { root, design, pagesDir, out, publicDir };
}

test('run() records a sha256 per page and overwrites an untouched page on the next run', async () => {
  const b = bundle();
  const args = { design: b.design, out: b.out, entry: 'ml/index.html', publicDir: b.publicDir, log: () => {} };
  await run(args);
  const m1 = JSON.parse(readFileSync(join(b.out, '_generated-manifest.json'), 'utf8'));
  const team = m1.pages.find((p) => p.file === 'team.astro');
  assert.equal(team.sha256, sha256(readFileSync(join(b.out, 'team.astro'), 'utf8')));

  writeFileSync(join(b.pagesDir, 'team.html'), PAGE('Team', '<p>team v2</p>'));
  await run(args);
  assert.match(readFileSync(join(b.out, 'team.astro'), 'utf8'), /team v2/);
});

test('run() stops and writes nothing when a generated page was hand edited', async () => {
  const b = bundle();
  const args = { design: b.design, out: b.out, entry: 'ml/index.html', publicDir: b.publicDir, log: () => {} };
  await run(args);

  // The hand fix lands in the output, the design moves on without it.
  const teamPath = join(b.out, 'team.astro');
  writeFileSync(teamPath, readFileSync(teamPath, 'utf8').replace('team v1', 'team v1 HAND FIX'));
  writeFileSync(join(b.pagesDir, 'team.html'), PAGE('Team', '<p>team v2</p>'));
  writeFileSync(join(b.pagesDir, 'index.html'), PAGE('Home', '<p>home v2</p>'));
  const manifestBefore = readFileSync(join(b.out, '_generated-manifest.json'), 'utf8');

  await assert.rejects(run(args), /team\.astro/);
  // Nothing moved: not the hand edited page, not the clean one, not the manifest.
  assert.match(readFileSync(teamPath, 'utf8'), /HAND FIX/);
  assert.match(readFileSync(join(b.out, 'index.astro'), 'utf8'), /home v1/);
  assert.equal(readFileSync(join(b.out, '_generated-manifest.json'), 'utf8'), manifestBefore);

  // --accept names the file and the design wins for that file.
  await run({ ...args, accept: ['team.astro'] });
  assert.match(readFileSync(teamPath, 'utf8'), /team v2/);
  assert.match(readFileSync(join(b.out, 'index.astro'), 'utf8'), /home v2/);
});

test('run() guards vendored stylesheets the same way', async () => {
  const b = bundle();
  mkdirSync(join(b.pagesDir, '_astro'));
  writeFileSync(join(b.pagesDir, '_astro', 'careers.AAA.css'), '.a{color:red}');
  const config = join(b.root, 'cfg.json');
  writeFileSync(config, JSON.stringify({ stylesOut: join(b.root, 'src', 'styles', 'design'), styles: { careers: 'site.css' } }));
  const args = { design: b.design, out: b.out, entry: 'ml/index.html', publicDir: b.publicDir, config, log: () => {} };
  await run(args);
  const css = join(b.root, 'src', 'styles', 'design', 'site.css');
  const m = JSON.parse(readFileSync(join(b.out, '_generated-manifest.json'), 'utf8'));
  assert.equal(m.stylesheets[0].sha256, sha256('.a{color:red}'));

  writeFileSync(css, '.a{color:red}.hand{}');
  writeFileSync(join(b.pagesDir, '_astro', 'careers.AAA.css'), '.a{color:blue}');
  await assert.rejects(run(args), /site\.css/);
  assert.equal(readFileSync(css, 'utf8'), '.a{color:red}.hand{}');
});
