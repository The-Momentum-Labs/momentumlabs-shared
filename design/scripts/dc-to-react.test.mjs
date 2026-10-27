/**
 * Tests for the .dc.html -> React converter.
 *
 * Run: node --test design/scripts/dc-to-react.test.mjs
 *
 * Every input below is a real construct lifted from
 * "AdmissionsOS App v2.dc.html" in the Student Portal Redesign project. The
 * expected output is checked against what Claude Design's own support.js does
 * with the same input, so a passing test means the port matches the tool rather
 * than matching my assumptions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, cssToObj, rewriteExpr, extractLogic, extractProps, propDefaults, importantify } from './dc-to-react.mjs';

const wrap = (inner) => `<x-dc>${inner}</x-dc>`;
const conv = (inner) => convert(wrap(inner));

/* ---------- expressions -------------------------------------------------- */

test('root identifiers get the view-model prefix', () => {
  assert.equal(rewriteExpr('crumb', new Set()), '__v.crumb');
  assert.equal(rewriteExpr('pillHelp.conn', new Set()), '__v.pillHelp.conn');
});

test('loop variables are left alone', () => {
  assert.equal(rewriteExpr('l.name', new Set(['l'])), 'l.name');
  assert.equal(rewriteExpr('l.pick', new Set(['l'])), 'l.pick');
});

test('literals and negation survive, matching the support.js grammar', () => {
  assert.equal(rewriteExpr('true', new Set()), 'true');
  assert.equal(rewriteExpr('!langOpen', new Set()), '!__v.langOpen');
  assert.equal(rewriteExpr('a === b', new Set()), '__v.a === __v.b');
});

test('string literals are copied verbatim, not prefixed', () => {
  assert.equal(rewriteExpr('x === "doc"', new Set()), '__v.x === "doc"');
});

/* ---------- the two control-flow tags ------------------------------------ */

test('sc-if becomes a ternary, not &&', () => {
  // && would render a literal 0 when the value is 0; support.js truthy-tests
  // and renders nothing, so a ternary is the faithful translation.
  const { markup } = conv('<sc-if value="{{ langOpen }}"><span>menu</span></sc-if>');
  assert.match(markup, /\{\(__v\.langOpen\) \? \(<React\.Fragment><span>menu<\/span><\/React\.Fragment>\) : null\}/);
  assert.ok(!markup.includes('&&'), 'must not use &&');
});

test('sc-for becomes a keyed map and scopes its variable', () => {
  const { markup } = conv('<sc-for list="{{ langs }}" as="l"><button onClick="{{ l.pick }}">{{ l.name }}</button></sc-for>');
  assert.match(markup, /\(__v\.langs \|\| \[\]\)\.map\(\(l, __i\) =>/);
  assert.match(markup, /key=\{__i\}/);
  assert.match(markup, /onClick=\{l\.pick\}/);
  assert.match(markup, /\{l\.name\}/);
  assert.ok(!markup.includes('__v.l.'), 'loop variable must not be prefixed');
});

test('hint-* attributes are editor-only and dropped', () => {
  const { markup } = conv('<sc-if value="{{ x }}" hint-placeholder-val="{{ true }}"><b>y</b></sc-if>');
  assert.ok(!markup.includes('hint-'), 'hint attributes leaked into output');
});

/* ---------- attributes --------------------------------------------------- */

test('event name casing is restored after parse5 lowercases it', () => {
  // parse5 turns onClick into onclick. Untreated, React silently never binds it
  // and every button in the app is dead.
  const { markup } = conv('<button onClick="{{ toggleLang }}">x</button>');
  assert.match(markup, /onClick=\{__v\.toggleLang\}/);
  assert.ok(!/onclick/.test(markup), 'lowercase onclick would never bind in React');
});

test('multi-word events use the same map support.js uses', () => {
  const { markup } = conv('<div onMouseEnter="{{ a }}" onDoubleClick="{{ b }}" onKeyDown="{{ c }}"></div>');
  assert.match(markup, /onMouseEnter=\{__v\.a\}/);
  assert.match(markup, /onDoubleClick=\{__v\.b\}/);
  assert.match(markup, /onKeyDown=\{__v\.c\}/);
});

test('class becomes className and for becomes htmlFor', () => {
  const { markup } = conv('<label class="brand-os" for="a">x</label>');
  assert.match(markup, /className="brand-os"/);
  assert.match(markup, /htmlFor="a"/);
});

test('svg presentation attributes take the camelCase name React expects', () => {
  // support.js passes these through in kebab and React still applies them, so
  // the DOM is identical, but it logs "Invalid DOM property" for each. This
  // design carries 552 of them, which would bury real console errors.
  const { markup } = conv('<svg stroke-width="2.5" stroke-linecap="round" stroke-dasharray="4 2"><path d="M9 18h6"></path></svg>');
  assert.match(markup, /strokeWidth="2.5"/);
  assert.match(markup, /strokeLinecap="round"/);
  assert.match(markup, /strokeDasharray="4 2"/);
});

test('data and aria attributes still pass through untouched', () => {
  const { markup } = conv('<div data-menu="1" data-app-root="1" aria-hidden="true"></div>');
  assert.match(markup, /data-menu="1"/);
  assert.match(markup, /data-app-root="1"/);
  assert.match(markup, /aria-hidden="true"/);
});

test('an empty attribute becomes a bare boolean prop', () => {
  const { markup } = conv('<input disabled="">');
  assert.match(markup, /<input disabled \/>/);
});

test('void elements self-close', () => {
  const { markup } = conv('<img src="assets/comet-mark.png" alt="AdmissionsOS">');
  assert.match(markup, /<img src="assets\/comet-mark\.png" alt="AdmissionsOS" \/>/);
});

test('a mixed-text attribute becomes a template literal', () => {
  const { markup } = conv('<div title="Hello {{ name }} there"></div>');
  assert.match(markup, /title=\{`Hello \$\{__v\.name \?\? ""\} there`\}/);
});

/* ---------- style -------------------------------------------------------- */

test('cssToObj matches support.js, including custom properties', () => {
  assert.deepEqual(cssToObj('background: red; font-size: 12px; --p-surface: #fff'), {
    background: 'red',
    fontSize: '12px',
    '--p-surface': '#fff',
  });
});

test('a static style string is converted to an object at build time', () => {
  const { markup } = conv('<div style="height: 100vh; display: flex"></div>');
  assert.match(markup, /style=\{\{ "height": "100vh", "display": "flex" \}\}/);
});

test('a dynamic style string is converted at run time by the same function', () => {
  const { markup } = conv('<button style="{{ connBtnStyle }}">x</button>');
  assert.match(markup, /style=\{__dcStyle\(__v\.connBtnStyle\)\}/);
});

test('style-hover becomes a real css rule plus a class', () => {
  const r = conv('<button style-hover="background: rgba(255,255,255,.16);">x</button>');
  assert.match(r.markup, /className="dc-h0"/);
  assert.equal(r.pseudoCss, '.dc-h0:hover{background:rgba(255,255,255,.16) !important}');
});

test('a dynamic hover value moves to a custom property and is read back with var()', () => {
  // A mustache cannot live in a static stylesheet, so the value has to ride on
  // the element and the rule has to point at it.
  const r = conv('<button style="color: red" style-hover="background: {{ hoverBg }};">x</button>');
  assert.match(r.pseudoCss, /\.dc-h0:hover\{background:var\(--dc-h0-background\) !important\}/);
  assert.match(r.markup, /__dcStyle\(/);
  assert.match(r.markup, /--dc-h0-background/);
});

test('a hover rule on an element with no style attribute still gets its property', () => {
  const r = conv('<button style-hover="background: {{ hoverBg }};">x</button>');
  assert.match(r.markup, /style=\{__dcStyle\(/, 'the custom property had nowhere to live');
  assert.match(r.markup, /--dc-h0-background/);
});

/* ---------- raw text and braces ------------------------------------------ */

test('stylesheet text goes through dangerouslySetInnerHTML so css braces survive', () => {
  // As JSX children, `@keyframes ember { ... }` would be parsed as an
  // expression and the build would fail or the rule would vanish.
  const { markup } = conv('<style>@keyframes ember { 0%, 100% { opacity: 1; } }</style>');
  assert.match(markup, /dangerouslySetInnerHTML=\{\{ __html: /);
  assert.match(markup, /@keyframes ember/);
});

test('literal braces in body text are escaped so JSX does not read them', () => {
  const { markup } = conv('<p>a { b } c</p>');
  assert.ok(!/<p>a \{ b \}/.test(markup));
  assert.match(markup, /&#123;/);
});

test('angle brackets in body text are escaped; JSX rejects them outright', () => {
  // The design renders "->" as a text arrow. esbuild fails with
  // 'The character ">" is not valid inside a JSX element'.
  const { markup } = conv('<span>-></span>');
  assert.ok(!markup.includes('>-><'), 'raw > in text will not compile');
  assert.match(markup, /&gt;/);
});

test('ampersands in body text round-trip to a single literal &', () => {
  // parse5 decodes text nodes, so both spellings arrive as "&" and are re-encoded
  // once. Emitting a bare "&" would let JSX try to read an entity.
  for (const src of ['<span>Kaplan &amp; Sons</span>', '<span>Kaplan & Sons</span>']) {
    assert.equal(convert(`<x-dc>${src}</x-dc>`).markup, '<span>Kaplan &amp; Sons</span>');
  }
});

/* ---------- component tags ----------------------------------------------- */

test('dc-import becomes a component with camel-cased props', () => {
  const r = conv('<dc-import name="TextEntry" value="{{ draft }}" on-value="{{ setDraftValue }}" serif="{{ false }}" tall="{{ true }}"></dc-import>');
  assert.deepEqual(r.imports, ['TextEntry']);
  assert.match(r.markup, /<TextEntry /);
  assert.match(r.markup, /value=\{__v\.draft\}/);
  assert.match(r.markup, /onValue=\{__v\.setDraftValue\}/);
  assert.match(r.markup, /serif=\{false\}/);
  assert.ok(!r.markup.includes('name="TextEntry"'), 'name is the tag, not a prop');
});

test('x-import resolves to the global component it names', () => {
  const r = conv('<x-import component-from-global-scope="image-slot" from="./image-slot.js" id="{{ fm.photoId }}" radius="10"></x-import>');
  assert.deepEqual(r.imports, ['ImageSlot']);
  assert.match(r.markup, /<ImageSlot /);
  assert.match(r.markup, /id=\{__v\.fm\.photoId\}/);
  assert.ok(!r.markup.includes('from='), 'the module path is not a prop');
});

/* ---------- helmet and the logic class ----------------------------------- */

test('the helmet is handed back raw, not smuggled into the tree', () => {
  const r = convert('<x-dc><helmet><style>a{color:red}</style></helmet><div>body</div></x-dc>');
  assert.match(r.helmet, /a\{color:red\}/);
  assert.match(r.markup, /<div>body<\/div>/);
  assert.ok(!r.markup.includes('color:red'), 'helmet css must not render as markup');
});

test('the logic class is extracted verbatim and never rewritten', () => {
  const html =
    '<x-dc><div>x</div></x-dc>\n' +
    '<script type="text/x-dc" data-dc-script>class Component extends DCLogic {\n  state = { step: 0 };\n  renderVals() { return { a: 1 }; }\n}</script>';
  const logic = extractLogic(html);
  assert.match(logic, /^class Component extends DCLogic \{/);
  assert.match(logic, /state = \{ step: 0 \};/);
  assert.match(logic, /renderVals\(\) \{ return \{ a: 1 \}; \}/);
});

test('the editor prop schema yields usable defaults', () => {
  const html = '<script type="text/x-dc" data-props="{&quot;palette&quot;: {&quot;default&quot;: &quot;Ivory&quot;}, &quot;wordPace&quot;: {&quot;default&quot;: 3}}">x</script>';
  assert.deepEqual(propDefaults(extractProps(html)), { palette: 'Ivory', wordPace: 3 });
});

/* ---------- guards ------------------------------------------------------- */

test('a file with no x-dc root is an error, not silently empty output', () => {
  assert.throws(() => convert('<html><body>nothing</body></html>'), /no <x-dc> root/);
});

test('a component name always starts with a capital', () => {
  // JSX reads a lowercase tag as a DOM element, so `imageSlot` would emit an
  // unknown html tag: nothing rendered, no error raised.
  for (const raw of ['image-slot', 'text entry', 'college list', 'TextEntry']) {
    const r = conv(`<dc-import name="${raw}"></dc-import>`);
    assert.match(r.imports[0], /^[A-Z]/, `"${raw}" produced "${r.imports[0]}"`);
    assert.match(r.markup, /^<[A-Z]/);
  }
});

test('the helmet keeps its <script src> list, which the tag emitter would drop', () => {
  // The emitter returns '' for every <script>. If the helmet came through it,
  // the whole demo-data list would silently vanish and the app would render
  // against undefined globals.
  const r = convert(
    '<x-dc><helmet>' +
      '<style>a{color:red}</style>' +
      '<script src="data/places.js"></script>' +
      '<script src="data/research.js"></script>' +
      '<link rel="stylesheet" href="./ds-tokens.css">' +
      '</helmet><div>body</div></x-dc>'
  );
  const srcs = [...r.helmet.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['data/places.js', 'data/research.js']);
  assert.match(r.helmet, /ds-tokens\.css/);
  assert.match(r.helmet, /a\{color:red\}/);
});

test('helmet script order is preserved, because these files read each other', () => {
  const r = convert(
    '<x-dc><helmet>' +
      '<script src="data/research.js"></script>' +
      '<script src="data/school-facts.js"></script>' +
      '</helmet><div/></x-dc>'
  );
  const srcs = [...r.helmet.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['data/research.js', 'data/school-facts.js']);
});

/* ---------- pseudo-rule fidelity ----------------------------------------- */

test('hover declarations get !important, as support.js does', () => {
  // These elements carry an inline style built by the logic class, and an inline
  // style beats a plain stylesheet rule. Without !important the hover is dead.
  const r = conv('<button style="{{ connBtnStyle }}" style-hover="background: rgba(255,255,255,.16);">x</button>');
  assert.equal(r.pseudoCss, '.dc-h0:hover{background:rgba(255,255,255,.16) !important}');
});

test('importantify splits on top-level semicolons only', () => {
  assert.equal(
    importantify('background:url(a;b.png);color:red'),
    'background:url(a;b.png) !important;color:red !important'
  );
  assert.equal(importantify('font-family:"a;b";color:red'), 'font-family:"a;b" !important;color:red !important');
  assert.equal(importantify('transform:translate(1px, 2px)'), 'transform:translate(1px, 2px) !important');
});

test('importantify does not double up an existing !important', () => {
  assert.equal(importantify('color:red !important'), 'color:red !important');
});

test('a whole-mustache style-hover is refused, not emitted as broken css', () => {
  // Real case: style-hover="{{ o.pillHover }}". The logic class builds the whole
  // block at run time, so no stylesheet can hold it. Emitting it produced
  // '.dc-h102:hover{{{ o.pillHover }}}' and failed the postcss build.
  const r = conv('<button style-hover="{{ o.pillHover }}">x</button>');
  assert.equal(r.pseudoCss, '');
  assert.ok(!r.markup.includes('dc-h'), 'no class should be attached');
  assert.deepEqual(r.unportable, [{ kind: 'style-hover', value: '{{ o.pillHover }}' }]);
});

test('a per-declaration mustache still works and is importantified', () => {
  const r = conv('<button style="color:red" style-hover="background: {{ hoverBg }};">x</button>');
  assert.equal(r.pseudoCss, '.dc-h0:hover{background:var(--dc-h0-background) !important}');
  assert.deepEqual(r.unportable, []);
});
