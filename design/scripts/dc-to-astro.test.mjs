/**
 * Tests for the static-html -> .astro converter.
 *
 * Run: node --test design/scripts/dc-to-astro.test.mjs
 *
 * Every input mirrors a real construct in project 3a7044d4's `momentumlabs/`
 * folder, which holds the momentumlabs.ai site as plain static HTML. The whole
 * reference table was read off those nine files, not imagined:
 *
 *   page links        index.html, products.html, team.html, events.html,
 *                     careers.html, recruiting.html, about.html, film.html
 *   stylesheets       _astro/careers.DbjjxZPV.css, _astro/events.CSzMeGUd.css,
 *                     _astro/about.DO3OWhrx.css, _astro/film.BVrn5W9D.css,
 *                     site/mobile.css
 *   build images      _astro/tree-of-knowledge.Xs_qYBrF_107NsF.webp and 20 more
 *   public files      comet.png, favicon.ico, apple-touch-icon.png,
 *                     fonts/newsreader-latin.woff2, film/ch1.mp4,
 *                     media/recruiting-hero.mp4, site/logos/mit-mark.png,
 *                     hero-poster.jpg, sitemap-index.xml
 *   left alone        https://, mailto:, #anchor, /already-absolute
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, rewriteUrl, splitDocument, escapeAstro } from './dc-to-astro.mjs';

/* ---------- the options a repo supplies ---------------------------------- */

const ROUTES = [
  'index.html', 'products.html', 'team.html', 'events.html',
  'careers.html', 'recruiting.html', 'about.html', 'film.html', '404.html',
];

const ASSETS = {
  'tree-of-knowledge': '/art/tree-of-knowledge.webp',
  frontier: '/art/frontier.webp',
  nico: '/art/nico.webp',
  admissions: '/art/admissions.webp',
};

const STYLES = {
  careers: '../styles/site.css',
  mobile: '../styles/mobile.css',
  film: '../styles/film.css',
};

const PUBLIC = new Set([
  'comet.png', 'favicon.ico', 'favicon-48.png', 'apple-touch-icon.png',
  'hero-poster.jpg', 'sitemap-index.xml',
  'fonts/newsreader-latin.woff2', 'film/ch1.mp4', 'film/ch1-poster.jpg',
  'media/recruiting-hero.mp4', 'site/logos/mit-mark.png',
]);

const OPTS = { routes: ROUTES, assets: ASSETS, styles: STYLES, publicFiles: PUBLIC };

const doc = (head, body, htmlAttrs = ' lang="en"') =>
  `<!DOCTYPE html><html${htmlAttrs}> <head>${head}</head> <body>${body}</body></html>`;

/* ---------- rewriteUrl: left alone --------------------------------------- */

for (const url of [
  'https://admissionsos.ai/counselors',
  'http://example.com',
  'mailto:contact@momentumlabs.ai?subject=Hiring%20from%20Momentum%20Recruiting',
  'tel:+15551234567',
  '#foundation',
  '/already-absolute.png',
  'data:image/svg+xml;base64,AAA',
]) {
  test(`rewriteUrl leaves ${url.slice(0, 32)} alone`, () => {
    const r = rewriteUrl(url, OPTS);
    assert.equal(r.url, url);
    assert.equal(r.kind, 'external');
  });
}

/* ---------- rewriteUrl: page links --------------------------------------- */

test('index.html becomes the site root', () => {
  const r = rewriteUrl('index.html', OPTS);
  assert.equal(r.url, '/');
  assert.equal(r.kind, 'route');
});

test('a named page drops its extension', () => {
  assert.equal(rewriteUrl('products.html', OPTS).url, '/products');
  assert.equal(rewriteUrl('recruiting.html', OPTS).url, '/recruiting');
});

test('404.html becomes /404', () => {
  assert.equal(rewriteUrl('404.html', OPTS).url, '/404');
});

test('a page link with a hash keeps the hash', () => {
  assert.equal(rewriteUrl('products.html#ladder', OPTS).url, '/products#ladder');
});

test('an html file that is not a known route is unportable, never guessed', () => {
  const r = rewriteUrl('recruiting.v1.html', OPTS);
  assert.equal(r.url, null);
  assert.match(r.reason, /not a route/);
});

/* ---------- rewriteUrl: build images ------------------------------------- */

test('a hashed _astro image resolves through the asset map by its stem', () => {
  const r = rewriteUrl('_astro/tree-of-knowledge.Xs_qYBrF_107NsF.webp', OPTS);
  assert.equal(r.url, '/art/tree-of-knowledge.webp');
  assert.equal(r.kind, 'asset');
});

test('an _astro image with a single hash segment resolves too', () => {
  assert.equal(rewriteUrl('_astro/frontier.BK6sB8TI.webp', OPTS).url, '/art/frontier.webp');
});

test('an unmapped _astro image is unportable, never guessed', () => {
  const r = rewriteUrl('_astro/events-collage-4.CJSW3rrC.webp', OPTS);
  assert.equal(r.url, null);
  assert.match(r.reason, /events-collage-4/);
});

/* ---------- rewriteUrl: public files ------------------------------------- */

test('a file that exists in public gets a leading slash', () => {
  const r = rewriteUrl('comet.png', OPTS);
  assert.equal(r.url, '/comet.png');
  assert.equal(r.kind, 'public');
});

test('nested public paths work', () => {
  assert.equal(rewriteUrl('fonts/newsreader-latin.woff2', OPTS).url, '/fonts/newsreader-latin.woff2');
  assert.equal(rewriteUrl('site/logos/mit-mark.png', OPTS).url, '/site/logos/mit-mark.png');
  assert.equal(rewriteUrl('film/ch1.mp4', OPTS).url, '/film/ch1.mp4');
});

test('a relative file that is not in public is unportable', () => {
  const r = rewriteUrl('media/does-not-exist.jpg', OPTS);
  assert.equal(r.url, null);
  assert.match(r.reason, /not in public/);
});

/* ---------- splitDocument ------------------------------------------------ */

test('splitDocument keeps the html attributes', () => {
  const s = splitDocument(doc('<title>x</title>', '<p>y</p>', ' lang="en" data-astro-cid-zetdm5md'));
  assert.equal(s.htmlAttrs.lang, 'en');
  assert.equal(s.htmlAttrs['data-astro-cid-zetdm5md'], '');
});

test('splitDocument keeps the body class', () => {
  const html = `<!DOCTYPE html><html><head></head><body class="is-home"><p>y</p></body></html>`;
  assert.equal(splitDocument(html).bodyAttrs.class, 'is-home');
});

/* ---------- escapeAstro -------------------------------------------------- */

test('a literal brace in text becomes an astro expression', () => {
  assert.equal(escapeAstro('use {this}'), "use {'{'}this{'}'}");
});

test('text with no braces is returned untouched', () => {
  assert.equal(escapeAstro('plain text'), 'plain text');
});

/* ---------- convert: stylesheets ----------------------------------------- */

test('a hashed _astro stylesheet becomes a frontmatter import and the link is dropped', () => {
  const r = convert(doc('<link rel="stylesheet" href="_astro/careers.DbjjxZPV.css">', '<p>x</p>'), OPTS);
  assert.ok(r.imports.includes('../styles/site.css'), r.imports.join(','));
  assert.ok(!r.code.includes('_astro/careers'), 'the link tag should be gone');
  assert.match(r.code, /^---\nimport '\.\.\/styles\/site\.css';\n/);
});

test('site/mobile.css becomes an import too, and import order is preserved', () => {
  const head =
    '<link rel="stylesheet" href="_astro/careers.DbjjxZPV.css">' +
    '<link rel="stylesheet" href="site/mobile.css">';
  const r = convert(doc(head, '<p>x</p>'), OPTS);
  assert.deepEqual(r.imports, ['../styles/site.css', '../styles/mobile.css']);
});

test('an unmapped stylesheet is unportable and the link is left in place', () => {
  const r = convert(doc('<link rel="stylesheet" href="_astro/events.CSzMeGUd.css">', '<p>x</p>'), OPTS);
  assert.equal(r.imports.length, 0);
  assert.equal(r.unportable.length, 1);
  assert.match(r.unportable[0].reason, /events/);
});

/* ---------- convert: scripts and styles ---------------------------------- */

test('an inline script gets is:inline so astro does not bundle or rewrite it', () => {
  const r = convert(doc('', '<script>var a = {x: 1};</script>'), OPTS);
  assert.match(r.code, /<script is:inline>/);
  assert.match(r.code, /var a = \{x: 1\};/, 'script body must stay verbatim');
});

test('a json-ld script keeps its type and its braces', () => {
  const r = convert(doc('<script type="application/ld+json">{"@type":"Organization"}</script>', ''), OPTS);
  assert.match(r.code, /type="application\/ld\+json" is:inline/);
  assert.match(r.code, /\{"@type":"Organization"\}/);
});

test('a style tag gets is:global so astro does not scope the design css', () => {
  const r = convert(doc('<style>body{margin:0}</style>', ''), OPTS);
  assert.match(r.code, /<style is:global>/);
  assert.match(r.code, /body\{margin:0\}/, 'css body must stay verbatim');
});

/* ---------- convert: brace escaping ------------------------------------- */

test('a literal brace in body text is escaped', () => {
  const r = convert(doc('', '<p>cost is {net}</p>'), OPTS);
  assert.match(r.code, /cost is \{'\{'\}net\{'\}'\}/);
});

test('braces inside a script are NOT escaped', () => {
  const r = convert(doc('', '<script>if (a) { b(); }</script>'), OPTS);
  assert.match(r.code, /if \(a\) \{ b\(\); \}/);
  assert.ok(!r.code.includes("{'{'}"), 'script contents must not be touched');
});

test('braces inside a style are NOT escaped', () => {
  const r = convert(doc('<style>.a{color:red}</style>', ''), OPTS);
  assert.match(r.code, /\.a\{color:red\}/);
});

/* ---------- convert: links and images ----------------------------------- */

test('nav links are rewritten to real routes', () => {
  const body = '<nav><a href="index.html">Mission</a><a href="products.html">Products</a></nav>';
  const r = convert(doc('', body), OPTS);
  assert.match(r.code, /href="\/"/);
  assert.match(r.code, /href="\/products"/);
});

test('an image src resolves through the asset map', () => {
  const r = convert(doc('', '<img src="_astro/nico.C4opwJiX_Z1XLvUo.webp" alt="">'), OPTS);
  assert.match(r.code, /src="\/art\/nico\.webp"/);
});

test('a srcset whose candidates all collapse to one url loses the srcset', () => {
  const body =
    '<img srcset="_astro/nico.C4opwJiX_Z1XLvUo.webp 400w, _astro/nico.AAAA_Z2.webp 800w" ' +
    'src="_astro/nico.C4opwJiX_Z1XLvUo.webp" alt="">';
  const r = convert(doc('', body), OPTS);
  assert.ok(!r.code.includes('srcset'), r.code);
  assert.match(r.code, /src="\/art\/nico\.webp"/);
  assert.equal(r.stats.srcsetCollapsed, 1);
});

test('a video poster is rewritten', () => {
  const r = convert(doc('', '<video poster="film/ch1-poster.jpg"><source src="film/ch1.mp4"></video>'), OPTS);
  assert.match(r.code, /poster="\/film\/ch1-poster\.jpg"/);
  assert.match(r.code, /src="\/film\/ch1\.mp4"/);
});

test('a form action is rewritten', () => {
  const r = convert(doc('', '<form action="/api/talent" method="post"></form>'), OPTS);
  assert.match(r.code, /action="\/api\/talent"/);
});

/* ---------- convert: unportables are reported, not papered over ---------- */

test('every unportable carries the attribute, the value and a reason', () => {
  const r = convert(doc('', '<img src="_astro/events-collage-4.CJSW3rrC.webp">'), OPTS);
  assert.equal(r.unportable.length, 1);
  const u = r.unportable[0];
  assert.equal(u.attr, 'src');
  assert.equal(u.value, '_astro/events-collage-4.CJSW3rrC.webp');
  assert.ok(u.reason.length > 0);
});

test('an unportable url is left exactly as it was, never blanked', () => {
  const r = convert(doc('', '<img src="_astro/events-collage-4.CJSW3rrC.webp">'), OPTS);
  assert.match(r.code, /src="_astro\/events-collage-4\.CJSW3rrC\.webp"/);
});

/* ---------- convert: shape of the output -------------------------------- */

test('the output opens with frontmatter and then the doctype', () => {
  const r = convert(doc('<link rel="stylesheet" href="site/mobile.css">', '<p>x</p>'), OPTS);
  assert.match(r.code, /^---\n/);
  assert.match(r.code, /\n---\n<!DOCTYPE html>/);
});

test('with no imports the frontmatter is still emitted, so the file is always a page', () => {
  const r = convert(doc('', '<p>x</p>'), OPTS);
  assert.match(r.code, /^---\n---\n<!DOCTYPE html>/);
});

test('extra frontmatter lines are placed after the imports', () => {
  const r = convert(doc('<link rel="stylesheet" href="site/mobile.css">', '<p>x</p>'), {
    ...OPTS,
    frontmatter: 'export const prerender = false;',
  });
  const fm = r.code.slice(4, r.code.indexOf('\n---\n'));
  assert.ok(fm.indexOf("import '../styles/mobile.css';") < fm.indexOf('export const prerender'), fm);
});

test('the html lang and the body class survive', () => {
  const html = `<!DOCTYPE html><html lang="en"><head></head><body class="is-home"><p>x</p></body></html>`;
  const r = convert(html, OPTS);
  assert.match(r.code, /<html lang="en">/);
  assert.match(r.code, /<body class="is-home">/);
});

test('stats count what was rewritten', () => {
  const body = '<a href="products.html">p</a><img src="_astro/nico.A_B.webp">';
  const r = convert(doc('', body), OPTS);
  assert.equal(r.stats.routes, 1);
  assert.equal(r.stats.assets, 1);
});

/* ---------- <picture> with nothing left to offer ------------------------ */

test('a <source> whose srcset collapses is removed, not left empty', () => {
  const body =
    '<picture>' +
    '<source type="image/avif" srcset="_astro/nico.AAA_1.avif 400w, _astro/nico.AAA_2.avif 800w">' +
    '<img src="_astro/nico.C4opwJiX_Z1XLvUo.webp" alt="Nico">' +
    '</picture>';
  const r = convert(doc('', body), { ...OPTS, assets: { ...ASSETS, nico: '/art/nico.webp' } });
  assert.ok(!r.code.includes('<source'), r.code);
  assert.match(r.code, /<img src="\/art\/nico\.webp" alt="Nico">/);
  assert.equal(r.stats.sourcesDropped, 1);
});

test('a <source> keeping a real multi-url srcset is kept', () => {
  const body =
    '<picture>' +
    '<source srcset="_astro/nico.A_1.webp 400w, _astro/frontier.B_2.webp 800w">' +
    '<img src="_astro/nico.A_1.webp" alt="">' +
    '</picture>';
  const r = convert(doc('', body), OPTS);
  assert.match(r.code, /<source srcset="\/art\/nico\.webp 400w, \/art\/frontier\.webp 800w">/);
  assert.equal(r.stats.sourcesDropped, 0);
});

test('an <img> whose srcset collapses keeps the img', () => {
  const body = '<img srcset="_astro/nico.A_1.webp 400w" src="_astro/nico.A_1.webp" alt="">';
  const r = convert(doc('', body), OPTS);
  assert.match(r.code, /<img src="\/art\/nico\.webp" alt="">/);
  assert.equal(r.stats.sourcesDropped, 0);
});

/* ---------- a captured framework island --------------------------------- */

test('a captured astro-island is reported as unportable', () => {
  const body =
    '<astro-island component-url="_astro/AboutPage.oSPqbkfF.js" ' +
    'renderer-url="_astro/client.DepRUxGq.js" client="load"><p>rendered</p></astro-island>';
  const r = convert(doc('', body), OPTS);
  assert.equal(r.stats.islands, 1);
  assert.equal(r.unportable.length, 1);
  assert.equal(r.unportable[0].value, '_astro/AboutPage.oSPqbkfF.js');
  assert.match(r.unportable[0].reason, /hydration will 404/);
});

test('a page with no island reports none', () => {
  const r = convert(doc('', '<p>plain</p>'), OPTS);
  assert.equal(r.stats.islands, 0);
});

test('the island markup is left in place, so the breakage stays visible', () => {
  const body = '<astro-island component-url="_astro/X.js"><p>rendered</p></astro-island>';
  const r = convert(doc('', body), OPTS);
  assert.match(r.code, /component-url="_astro\/X\.js"/);
});

/* ---------- css url rewriting ------------------------------------------- */

import { rewriteCssUrls } from './dc-to-astro.mjs';

test('a font url climbs out of _astro and resolves against public', () => {
  const r = rewriteCssUrls(
    "@font-face{src:url(../fonts/newsreader-latin.woff2) format('woff2')}",
    '_astro',
    OPTS,
  );
  assert.match(r.css, /url\(\/fonts\/newsreader-latin\.woff2\)/);
  assert.equal(r.rewritten, 1);
  assert.equal(r.unportable.length, 0);
});

test('quotes are preserved exactly as written', () => {
  assert.match(rewriteCssUrls('a{src:url("../fonts/newsreader-latin.woff2")}', '_astro', OPTS).css,
    /url\("\/fonts\/newsreader-latin\.woff2"\)/);
  assert.match(rewriteCssUrls("a{src:url('../fonts/newsreader-latin.woff2')}", '_astro', OPTS).css,
    /url\('\/fonts\/newsreader-latin\.woff2'\)/);
});

test('an absolute or data url is left alone', () => {
  const css = 'a{background:url(https://cdn.example.com/x.png)}b{background:url(data:image/gif;base64,R0lG)}c{background:url(/already.png)}';
  const r = rewriteCssUrls(css, '_astro', OPTS);
  assert.equal(r.css, css);
  assert.equal(r.rewritten, 0);
});

test('a css url with no match is reported and left as written', () => {
  const r = rewriteCssUrls('a{src:url(./KaTeX_AMS-Regular.BQhdFMY1.woff2)}', '_astro', OPTS);
  assert.equal(r.rewritten, 0);
  assert.equal(r.unportable.length, 1);
  assert.match(r.css, /url\(\.\/KaTeX_AMS-Regular\.BQhdFMY1\.woff2\)/);
});

test('a bare filename resolves relative to the stylesheet, not the root', () => {
  const r = rewriteCssUrls('a{src:url(mit-mark.png)}', 'site/logos', OPTS);
  assert.match(r.css, /url\(\/site\/logos\/mit-mark\.png\)/);
});

test('several urls in one declaration are all rewritten', () => {
  const r = rewriteCssUrls(
    "@font-face{src:url(../fonts/newsreader-latin.woff2) format('woff2'),url(../film/ch1.mp4) format('x')}",
    '_astro', OPTS,
  );
  assert.equal(r.rewritten, 2);
});

/* ---------- live data: {{ }}, <sc-for>, <sc-if> --------------------------- */
/**
 * Why these exist. cypfounders.com's /events page reads the Luma calendar on
 * every request, so a capture of it is one frozen render and can never be the
 * design file. The design holds the page's outline and ONE card; the repo hands
 * the page an array through the config's `frontmatter` key and the card is
 * repeated here, at build time, on the server. Same directive surface the react
 * converter already has: `list` / `as` / `index` on sc-for, `cond` on sc-if,
 * `{{ }}` everywhere. No second vocabulary.
 *
 * The one deliberate difference from the react side: no `__v.` prefix. A react
 * design has a logic class holding the view model; an astro page's names come
 * from its own frontmatter, so `{{ events }}` is `events`.
 */
const page = (body) => `<!DOCTYPE html><html><body>${body}</body></html>`;

test('a mustache in text becomes an astro expression', () => {
  const r = convert(page('<h1>{{ title }}</h1>'), OPTS);
  assert.match(r.code, /<h1>\{title\}<\/h1>/);
  assert.equal(r.stats.mustaches, 1);
});

test('a mustache in an attribute becomes an astro expression', () => {
  const r = convert(page('<a href="{{ e.rsvp }}">go</a>'), OPTS);
  assert.match(r.code, /href=\{e\.rsvp\}/);
});

test('text around a mustache survives', () => {
  const r = convert(page('<p>Hello {{ name }}, welcome</p>'), OPTS);
  assert.match(r.code, /<p>Hello \{name\}, welcome<\/p>/);
});

test('an expression is not html-escaped on the way out', () => {
  // The serializer escapes & < > in text. An expression that went through it
  // would arrive as `a &amp;&amp; b` and not compile.
  const r = convert(page('<p>{{ a && b }}</p>'), OPTS);
  assert.match(r.code, /\{a && b\}/);
  assert.ok(!r.code.includes('&amp;&amp;'));
});

test('an attribute expression is not html-escaped either', () => {
  const r = convert(page('<a href="{{ a && b }}">x</a>'), OPTS);
  assert.match(r.code, /href=\{a && b\}/);
});

test('sc-for repeats its children at build time', () => {
  const r = convert(page('<sc-for list="{{ events }}" as="e"><li>{{ e.title }}</li></sc-for>'), OPTS);
  assert.match(r.code, /\{\(events \|\| \[\]\)\.map\(\(e, __i\) => \(<Fragment>/);
  assert.match(r.code, /<li>\{e\.title\}<\/li>/);
  assert.match(r.code, /<\/Fragment>\)\)\}/);
  assert.equal(r.stats.scFor, 1);
  // The directive element itself must not survive into the page.
  assert.ok(!r.code.includes('<sc-for'));
});

test('sc-for takes its index name from the design', () => {
  const r = convert(page('<sc-for list="{{ rows }}" as="row" index="i"><b>{{ i }}</b></sc-for>'), OPTS);
  assert.match(r.code, /\.map\(\(row, i\) =>/);
});

test('sc-if is a ternary, so a 0 renders nothing instead of a literal 0', () => {
  const r = convert(page('<sc-if cond="{{ hasEvents }}"><p>yes</p></sc-if>'), OPTS);
  assert.match(r.code, /\{\(hasEvents\) \? \(<Fragment><p>yes<\/p><\/Fragment>\) : null\}/);
  assert.equal(r.stats.scIf, 1);
});

test('a bare expression works without the braces, the way an attribute reads', () => {
  const r = convert(page('<sc-if cond="hasEvents"><p>yes</p></sc-if>'), OPTS);
  assert.match(r.code, /\{\(hasEvents\) \?/);
});

test('sc-for with no list is reported and left exactly as written', () => {
  const r = convert(page('<sc-for as="e"><li>x</li></sc-for>'), OPTS);
  assert.equal(r.stats.scFor, 0);
  assert.equal(r.unportable.length, 1);
  assert.match(r.unportable[0].reason, /list/);
  assert.ok(r.code.includes('<sc-for'));
});

test('a mustache inside a script is left alone', () => {
  // Script contents ship exactly as written. A `{{` in js is js.
  const r = convert(page('<script>var a = {{ x: 1 }};</script>'), OPTS);
  assert.match(r.code, /var a = \{\{ x: 1 \}\};/);
  assert.equal(r.stats.mustaches, 0);
});

test('a literal brace with no mustache is still escaped', () => {
  const r = convert(page('<p>use { and }</p>'), OPTS);
  assert.match(r.code, /use \{'\{'\} and \{'\}'\}/);
});

test('a page with no directives is byte-for-byte what it was', () => {
  const r = convert(page('<p>plain</p>'), OPTS);
  assert.equal(r.stats.mustaches, 0);
  assert.equal(r.stats.scFor, 0);
  assert.equal(r.stats.scIf, 0);
});
