/**
 * Tests for the converter-target detector.
 *
 * Run: node --test design/scripts/dc-detect.test.mjs
 *
 * Every input below mirrors a real file. The react cases come from
 * "AdmissionsOS App v2.dc.html" in the Student Portal Redesign project. The
 * astro cases come from `momentumlabs/index.html` and `momentumlabs/404.html`
 * in project 3a7044d4, which hold the company site as plain static HTML.
 *
 * The point of this module is that no agent ever picks the target by hand, so
 * the tests care most about two things: the order the markers are checked in,
 * and that a contradicting --target is a hard failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, assertTarget } from './dc-detect.mjs';

/* ---------- real-shape fixtures ------------------------------------------ */

// The head of the AdmissionsOS design file, verbatim in shape.
const DC_HEAD = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>:root{--paper:#faf7f4}</style></helmet>
<div class="shell">Hello</div>
`;

const DC_LOGIC = `<script type="text/x-dc" data-dc-script data-props="{}">
class Component extends DCLogic {
  init() {}
}
</script>`;

// momentumlabs/index.html: a full document, no x-dc anywhere.
const ASTRO_PAGE = `<!DOCTYPE html><html lang="en"> <head><meta charset="UTF-8">` +
  `<title>Momentum Labs</title>` +
  `<link rel="canonical" href="https://momentumlabs.ai/">` +
  `<script type="application/ld+json">{"@type":"Organization"}</script>` +
  `</head> <body class="is-home"> <header class="site-header"></header> </body></html>`;

// momentumlabs/404.html opens with an Astro scope attribute on <html>.
const ASTRO_404 = `<!DOCTYPE html><html lang="en" data-astro-cid-zetdm5md> <head>` +
  `<title>Not found</title></head> <body><h1>404</h1></body></html>`;

/* ---------- react detection ---------------------------------------------- */

test('a dc file with its logic class reads as react', () => {
  const r = detect(DC_HEAD + DC_LOGIC);
  assert.equal(r.target, 'react');
  assert.equal(r.hasLogic, true);
});

test('the text/x-dc script alone is enough to read as react', () => {
  const r = detect(`<html><body>${DC_LOGIC}</body></html>`);
  assert.equal(r.target, 'react');
  assert.equal(r.hasLogic, true);
});

test('an x-dc template with no logic class is still react, and says so', () => {
  const r = detect(DC_HEAD);
  assert.equal(r.target, 'react');
  assert.equal(r.hasLogic, false);
});

test('StreamableLogic counts as a logic class', () => {
  const src = DC_HEAD + `<script type="text/x-dc">
class Component extends StreamableLogic { init() {} }
</script>`;
  assert.equal(detect(src).hasLogic, true);
});

test('a logic class for some other base does not count', () => {
  const src = DC_HEAD + `<script type="text/x-dc">
class Component extends HTMLElement {}
</script>`;
  const r = detect(src);
  assert.equal(r.target, 'react');
  assert.equal(r.hasLogic, false);
});

/* ---------- astro detection ---------------------------------------------- */

test('momentumlabs/index.html reads as astro', () => {
  const r = detect(ASTRO_PAGE);
  assert.equal(r.target, 'astro');
  assert.equal(r.hasLogic, false);
});

test('momentumlabs/404.html reads as astro despite the astro scope attribute', () => {
  assert.equal(detect(ASTRO_404).target, 'astro');
});

test('a lowercase doctype still reads as astro', () => {
  assert.equal(detect('<!doctype html><html><body>x</body></html>').target, 'astro');
});

test('an html element with no doctype still reads as astro', () => {
  assert.equal(detect('<html lang="en"><body>x</body></html>').target, 'astro');
});

/* ---------- order of the checks ------------------------------------------ */

// This is the one that matters. A .dc.html file is also a complete html
// document, so checking for <html> first would read every design file as astro.
test('x-dc wins over the html document check', () => {
  const r = detect(DC_HEAD + DC_LOGIC);
  assert.equal(r.target, 'react');
});

test('the word x-dc inside ordinary text does not trigger react', () => {
  const src = `<!DOCTYPE html><html><body><p>we call it x-dc here</p></body></html>`;
  assert.equal(detect(src).target, 'astro');
});

/* ---------- unknown shapes ----------------------------------------------- */

test('a bare fragment has no target and never throws', () => {
  const r = detect('<div class="card">just a fragment</div>');
  assert.equal(r.target, null);
  assert.match(r.evidence, /no <x-dc>/);
});

test('an empty file has no target', () => {
  assert.equal(detect('').target, null);
});

/* ---------- evidence ----------------------------------------------------- */

test('every result carries non-empty evidence', () => {
  for (const src of [DC_HEAD + DC_LOGIC, ASTRO_PAGE, '<div>x</div>', '']) {
    const r = detect(src);
    assert.equal(typeof r.evidence, 'string');
    assert.ok(r.evidence.length > 0, `empty evidence for ${JSON.stringify(src.slice(0, 20))}`);
  }
});

test('react evidence names the marker that matched', () => {
  assert.match(detect(DC_HEAD).evidence, /<x-dc/);
  assert.match(detect(`<html>${DC_LOGIC}</html>`).evidence, /text\/x-dc/);
});

/* ---------- assertTarget: the enforcement -------------------------------- */

test('assertTarget returns the detected target when nothing was requested', () => {
  const detected = detect(ASTRO_PAGE);
  assert.equal(assertTarget({ detected, file: 'index.html' }), 'astro');
});

test('assertTarget returns the target when the request agrees', () => {
  const detected = detect(ASTRO_PAGE);
  assert.equal(assertTarget({ detected, requested: 'astro', file: 'index.html' }), 'astro');
});

test('assertTarget throws when the request contradicts the file', () => {
  const detected = detect(ASTRO_PAGE);
  assert.throws(
    () => assertTarget({ detected, requested: 'react', file: 'momentumlabs/index.html' }),
    (err) => {
      assert.match(err.message, /momentumlabs\/index\.html/);
      assert.match(err.message, /react/);
      assert.match(err.message, /astro/);
      assert.match(err.message, /plain html document/);
      return true;
    },
  );
});

test('assertTarget throws for an unknown shape, requested or not', () => {
  const detected = detect('<div>fragment</div>');
  assert.throws(() => assertTarget({ detected, file: 'bits.html' }), /bits\.html/);
  assert.throws(() => assertTarget({ detected, requested: 'astro', file: 'bits.html' }), /bits\.html/);
});

test('assertTarget rejects a target name that is not a real target', () => {
  const detected = detect(ASTRO_PAGE);
  assert.throws(
    () => assertTarget({ detected, requested: 'vue', file: 'index.html' }),
    /vue/,
  );
});
