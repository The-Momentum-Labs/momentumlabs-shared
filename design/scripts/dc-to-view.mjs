#!/usr/bin/env node
/**
 * dc-to-view.mjs — transpile a Claude Design `.dc.html` screen into a React
 * VIEW: a pure function of a bindings object, with no logic class.
 *
 * This is the second React target. `dc-to-react.mjs` ports the design's own
 * logic class and the app subclasses it. This one throws the logic class away
 * and emits `<Name>ScreenView({ v })`, where `v` is every binding the markup
 * reads, so the app supplies the data and the handlers itself. Pick it when the
 * design is a canvas over live app state and the design's logic class is only
 * the preview's stand-in for that state (BusinessOS Sales is the first case).
 *
 * Why a program: the shipped UI must be IDENTICAL to the design. Hand-porting
 * ~1000 inline style strings would drift, with no way to prove it had not. A
 * program copies the style strings verbatim, and the round-trip check proves
 * the parse lost nothing.
 *
 * Correctness contract, asserted on every run:
 *   1. parse(markup) -> serialize(ast) equals the input byte-for-byte.
 *   2. every style string in the input appears verbatim in the output.
 *   3. with --check, the files on disk equal what would be written.
 *
 * Emits into --out:
 *   <Name>ScreenView.tsx            the view
 *   bindings.generated.ts           interface <Name>Bindings + the name list
 *   bindings.inert.generated.ts     INERT_BINDINGS, shaped by how each is used
 *   <Name>HeaderView.tsx            the <header> subtree alone, with --header
 *
 * The view imports from `./dcRuntime` (dcStyle, dcState, dcList, dcKey, only the
 * ones it calls) in --out.
 * That file is the repo's, hand-written once per app; this tool does not ship it.
 *
 * Usage, one screen per run (dc-gen.mjs loops a manifest over this):
 *   node dc-to-view.mjs --design <dir> --entry <file.dc.html> --out <dir> --name <Name>
 *                       [--label <screen label>] [--header] [--check]
 *   --design  the pulled design folder; must sit INSIDE --out, because the
 *             generated view imports the design's assets by relative path
 *   --label   the data-screen-label of the screen root, default --name
 *   --header  also emit <Name>HeaderView.tsx from the design's <header>
 *   --check   validate only, write nothing; exit 1 when a file is stale
 * Paths are relative to the current working directory, the repo root.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, extname, basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardedWrite } from './merge-guard.mjs';

/** Fingerprints of the last write, the merge guard's base. Lives in outDir. */
export const GEN_MANIFEST = '_generated-manifest.json';

// Tags that never carry a closing tag in this document.
const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr']);

// Attributes that are editor-only affordances in Claude Design and carry no
// runtime meaning. Dropped.
const DROP_ATTR = /^(hint-placeholder|data-dc-|data-screen-label$)/;

// HTML attribute -> JSX prop. Anything not listed and not containing a dash is
// passed through unchanged; anything with a dash that is not listed is an error,
// so a new SVG attribute cannot silently ship as a broken prop.
const PROP = {
  class: 'className',
  for: 'htmlFor',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'fill-rule': 'fillRule',
  'fill-opacity': 'fillOpacity',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'font-size': 'fontSize',
  'font-family': 'fontFamily',
  'font-weight': 'fontWeight',
  'letter-spacing': 'letterSpacing',
  'paint-order': 'paintOrder',
  'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'xml-space': 'xmlSpace',
  'accept-charset': 'acceptCharset',
  'auto-complete': 'autoComplete',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  tabindex: 'tabIndex',
  contenteditable: 'contentEditable',
  spellcheck: 'spellCheck',
  allowfullscreen: 'allowFullScreen',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  srcset: 'srcSet',
  novalidate: 'noValidate',
  enctype: 'encType',
  usemap: 'useMap',
  datetime: 'dateTime',
  inputmode: 'inputMode',
  enterkeyhint: 'enterKeyHint',
  crossorigin: 'crossOrigin',
  referrerpolicy: 'referrerPolicy',
};

// Relative asset paths in the design -> the module import that replaces them.
// How each top-level binding is used, so the inert default can be the right
// shape. Derived from the markup, never guessed.
const USE = { list: new Set(), cond: new Set(), handler: new Set(), ref: new Set() };
const noteUse = (kind, expr) => {
  const m = /^v\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(expr);
  if (m) USE[kind].add(m[1]);
};

// Relative asset files the markup references by `src`, e.g. `comet.png`. Each
// becomes a module import so Vite fingerprints the file. The identifier is the
// file name camel-cased with its extension capitalised: comet.png -> cometPng.
const usedAssets = new Set();
const assetIdent = (file) => {
  const ext = extname(file);
  const stem = basename(file, ext).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  return stem.replace(/^[^A-Za-z_$]/, '_$&') + ext.slice(1, 2).toUpperCase() + ext.slice(2).toLowerCase();
};
const isAssetRef = (value) => /^[^/:?#]+\.[A-Za-z0-9]+$/.test(value);

// Where the screen's design folder sits relative to its generated files. Set per
// screen, because every screen keeps its own design folder.
let assetBase = './design';
let designDirAbs = '';

// Attributes whose value is a string but which React types as boolean.
const NUM_PROP = new Set(['rows', 'cols', 'tabIndex', 'maxLength', 'minLength', 'colSpan', 'rowSpan', 'size', 'span']);
const BOOL_PROP = new Set(['multiple', 'disabled', 'checked', 'readOnly', 'autoFocus', 'required', 'noValidate', 'spellCheck', 'muted', 'controls', 'autoPlay', 'loop', 'playsInline', 'hidden', 'open', 'allowFullScreen']);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Tokenising parser for the .dc markup subset. Produces nodes that carry their
 * exact source text so serialize() can rebuild the input byte-for-byte.
 */
function parse(src) {
  let i = 0;
  const root = { type: 'root', children: [] };
  const stack = [root];

  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end === -1) throw new Error('unterminated comment at ' + lt);
      top().children.push({ type: 'comment', raw: src.slice(lt, end + 3) });
      i = end + 3;
      continue;
    }

    if (src[lt + 1] === '/') {
      const gt = src.indexOf('>', lt);
      if (gt === -1) throw new Error('unterminated close tag at ' + lt);
      const name = src.slice(lt + 2, gt).trim();
      const node = top();
      if (node.type !== 'element' || node.name !== name) {
        throw new Error(
          `mismatched close </${name}> at ${lt}; open is ${node.type === 'element' ? '<' + node.name + '>' : node.type}`,
        );
      }
      node.closed = true;
      stack.pop();
      i = gt + 1;
      continue;
    }

    // Open tag. Scan to the matching '>' respecting quoted attribute values.
    let j = lt + 1;
    let quote = null;
    while (j < src.length) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= src.length) throw new Error('unterminated open tag at ' + lt);

    const inner = src.slice(lt + 1, j);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(body);
    if (!nameMatch) throw new Error('bad tag name at ' + lt);
    const name = nameMatch[0];
    const attrs = parseAttrs(body.slice(name.length), lt);

    const node = { type: 'element', name, attrs, selfClosing, children: [], closed: false };
    top().children.push(node);
    i = j + 1;
    if (!selfClosing && !VOID.has(name)) stack.push(node);
  }

  if (stack.length !== 1) {
    const open = stack[stack.length - 1];
    throw new Error('unclosed <' + open.name + '>');
  }
  return root;

  function pushText(text) {
    if (text === '') return;
    top().children.push({ type: 'text', raw: text });
  }
}

/** Parses an attribute list, preserving the exact whitespace between attributes. */
function parseAttrs(s, at) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const wsStart = i;
    while (i < s.length && /\s/.test(s[i])) i++;
    const ws = s.slice(wsStart, i);
    if (i >= s.length) {
      if (ws) out.push({ type: 'ws', raw: ws });
      break;
    }
    const nameMatch = /^[^\s=/>]+/.exec(s.slice(i));
    if (!nameMatch) throw new Error('bad attribute near ' + at);
    const name = nameMatch[0];
    i += name.length;
    if (s[i] === '=') {
      i++;
      const q = s[i];
      if (q !== '"' && q !== "'") throw new Error('unquoted attribute value for ' + name + ' near ' + at);
      const end = s.indexOf(q, i + 1);
      if (end === -1) throw new Error('unterminated attribute value for ' + name + ' near ' + at);
      out.push({ type: 'attr', ws, name, quote: q, value: s.slice(i + 1, end) });
      i = end + 1;
    } else {
      out.push({ type: 'attr', ws, name, quote: null, value: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialize (the round-trip proof)
// ---------------------------------------------------------------------------

function serialize(node) {
  if (node.type === 'root') return node.children.map(serialize).join('');
  if (node.type === 'text') return node.raw;
  if (node.type === 'comment') return node.raw;
  const attrs = node.attrs
    .map((a) => (a.type === 'ws' ? a.raw : a.quote ? `${a.ws}${a.name}=${a.quote}${a.value}${a.quote}` : `${a.ws}${a.name}`))
    .join('');
  const open = `<${node.name}${attrs}${node.selfClosing ? '/' : ''}>`;
  if (node.selfClosing || VOID.has(node.name)) return open;
  return open + node.children.map(serialize).join('') + `</${node.name}>`;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const BIND = /\{\{\s*([^}]*?)\s*\}\}/g;

/** True when the whole value is exactly one binding, e.g. `{{ foo }}`. */
function soleBinding(value) {
  const m = /^\{\{\s*([^}]*?)\s*\}\}$/.exec(value);
  return m ? m[1] : null;
}

/** Qualifies a binding path: loop variables stay local, everything else is `v.x`. */
function qualify(expr, scope) {
  const head = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expr);
  if (!head) throw new Error('unsupported binding expression: ' + expr);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(expr)) {
    throw new Error('unsupported binding expression: ' + expr);
  }
  if (expr === 'true' || expr === 'false' || expr === 'null' || expr === 'undefined') return expr;
  return scope.has(head[0]) ? expr : 'v.' + expr;
}

/** Turns a mixed literal/binding attribute value into a JS template literal. */
function interpolate(value, scope) {
  const sole = soleBinding(value);
  if (sole !== null) return qualify(sole, scope);
  let out = '';
  let last = 0;
  BIND.lastIndex = 0;
  let m;
  while ((m = BIND.exec(value))) {
    out += tplChunk(value.slice(last, m.index));
    out += '${' + qualify(m[1], scope) + '}';
    last = m.index + m[0].length;
  }
  out += tplChunk(value.slice(last));
  return '`' + out + '`';
}

function tplChunk(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function hasBinding(value) {
  BIND.lastIndex = 0;
  return BIND.test(value);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  middot: '·', hellip: '…', mdash: '—', ndash: '–', times: '×',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•',
  deg: '°', laquo: '«', raquo: '»', trade: '™', reg: '®',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return body in ENTITIES ? ENTITIES[body] : whole;
  });
}

function jsString(s) {
  return JSON.stringify(s);
}

let hoverCount = 0;

function emitNode(node, scope, indent) {
  const pad = '  '.repeat(indent);

  if (node.type === 'comment') return '';

  if (node.type === 'text') {
    // Whitespace-only runs between elements still matter for inline layout, so
    // they are emitted as explicit string children rather than left to JSX's
    // whitespace trimming.
    const raw = node.raw;
    if (raw.trim() === '' && !raw.includes(' ')) {
      return raw.includes('\n') ? '' : `${pad}{${jsString(raw)}}\n`;
    }
    const parts = [];
    let last = 0;
    BIND.lastIndex = 0;
    let m;
    while ((m = BIND.exec(raw))) {
      const lit = raw.slice(last, m.index);
      if (lit) parts.push(jsString(decodeEntities(lit)));
      parts.push(qualify(m[1], scope));
      last = m.index + m[0].length;
    }
    const tail = raw.slice(last);
    if (tail) parts.push(jsString(decodeEntities(tail)));
    return parts.map((p) => `${pad}{${p}}\n`).join('');
  }

  // <dc-import name="CashFlow"> pulls a sibling design file in as a component.
  // In view mode the app owns every screen's data, so an import becomes a slot:
  // a binding named import<Name> that the app fills with the rendered screen.
  // This is what lets ONE design file host every space of the app.
  if (node.name === 'dc-import') {
    const nameAttr = node.attrs.find((a) => a.type === 'attr' && a.name === 'name');
    if (!nameAttr || !nameAttr.value) throw new Error('<dc-import> without name');
    const ident = 'import' + nameAttr.value.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase());
    return `${pad}{${qualify(ident, scope)}}\n`;
  }

  if (node.name === 'sc-if') {
    const valueAttr = node.attrs.find((a) => a.type === 'attr' && a.name === 'value');
    if (!valueAttr) throw new Error('<sc-if> without value');
    const cond = interpolate(valueAttr.value, scope);
    noteUse('cond', cond);
    const kids = emitChildren(node, scope, indent + 2);
    return `${pad}{${cond} ? (\n${pad}  <>\n${kids}${pad}  </>\n${pad}) : null}\n`;
  }

  if (node.name === 'sc-for') {
    const listAttr = node.attrs.find((a) => a.type === 'attr' && a.name === 'list');
    const asAttr = node.attrs.find((a) => a.type === 'attr' && a.name === 'as');
    if (!listAttr || !asAttr) throw new Error('<sc-for> without list/as');
    const list = interpolate(listAttr.value, scope);
    noteUse('list', list);
    const item = asAttr.value;
    const inner = new Set(scope);
    inner.add(item);
    const kids = emitChildren(node, inner, indent + 2);
    return (
      `${pad}{dcList(${list}).map((${item}, ${item}__i) => (\n` +
      `${pad}  <Fragment key={dcKey(${item}, ${item}__i)}>\n` +
      kids +
      `${pad}  </Fragment>\n` +
      `${pad}))}\n`
    );
  }

  // Plain element.
  const props = [];
  const stateStyles = [];
  for (const a of node.attrs) {
    if (a.type !== 'attr') continue;
    if (DROP_ATTR.test(a.name)) continue;

    const stateMatch = /^style-(hover|focus-within|focus|active)$/.exec(a.name);
    if (stateMatch) {
      stateStyles.push([stateMatch[1], a.value]);
      continue;
    }

    if (a.name === 'style') {
      props.push(`style={dcStyle(${interpolate(a.value, scope)})}`);
      continue;
    }

    let prop = PROP[a.name] ?? a.name;
    if (prop.includes('-') && !prop.startsWith('data-') && !prop.startsWith('aria-')) {
      throw new Error(`unmapped dashed attribute "${a.name}" on <${node.name}> — add it to PROP`);
    }

    if (a.quote === null) {
      props.push(`${prop}`);
      continue;
    }

    if (BOOL_PROP.has(prop)) {
      const sole = soleBinding(a.value);
      props.push(`${prop}={${sole !== null ? qualify(sole, scope) : a.value === 'false' ? 'false' : 'true'}}`);
      continue;
    }

    // Relative asset paths work in the Claude Design preview but not under Vite.
    // Rewrite them to a module import so the bundler fingerprints the file.
    if (prop === 'src' && isAssetRef(a.value) && existsSync(resolve(designDirAbs, a.value))) {
      usedAssets.add(a.value);
      props.push(`src={${assetIdent(a.value)}}`);
      continue;
    }

    if (hasBinding(a.value)) {
      const expr = interpolate(a.value, scope);
      if (/^on[A-Z]/.test(prop)) noteUse('handler', expr);
      else if (prop === 'ref') noteUse('ref', expr);
      props.push(`${prop}={${expr}}`);
    } else if (NUM_PROP.has(prop) && /^-?\d+$/.test(a.value)) {
      // React types these as numbers; a string literal fails tsc.
      props.push(`${prop}={${a.value}}`);
    } else {
      props.push(`${prop}=${jsString(decodeEntities(a.value))}`);
    }
  }

  for (const [state, css] of stateStyles) {
    hoverCount++;
    const cls = `dcState(${interpolate(css, scope)}, ${jsString(state)})`;
    const existing = props.findIndex((p) => p.startsWith('className='));
    if (existing >= 0) {
      const prev = props[existing].slice('className='.length);
      const prevExpr = prev.startsWith('{') ? prev.slice(1, -1) : prev;
      props[existing] = `className={${prevExpr} + " " + ${cls}}`;
    } else {
      props.push(`className={${cls}}`);
    }
  }

  const name = node.name;
  const propText = props.length ? ' ' + props.join(' ') : '';
  const selfClose = VOID.has(name) || node.selfClosing || node.children.length === 0;

  if (selfClose && node.children.length === 0) {
    return `${pad}<${name}${propText} />\n`;
  }
  const kids = emitChildren(node, scope, indent + 1);
  return `${pad}<${name}${propText}>\n${kids}${pad}</${name}>\n`;
}

function emitChildren(node, scope, indent) {
  return node.children.map((c) => emitNode(c, scope, indent)).join('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * The emit accumulates into module-level state (how each binding is used, which
 * assets were referenced, how many state-style rules were seen). A run over
 * several screens has to start each one clean or screen two inherits screen
 * one's shapes.
 */
function resetState() {
  for (const kind of Object.keys(USE)) USE[kind].clear();
  usedAssets.clear();
  hoverCount = 0;
}

/**
 * Transpile one screen. Returns the files it would write, as [absolute path,
 * contents]. Writing is the caller's job so that --check can compare instead.
 *
 * `screen` is { name, entry, designDir, outDir, screenLabel?, header? } with
 * paths relative to `root`. This is the shape of one entry in a repo's
 * design.config.json, so dc-gen.mjs can pass a manifest entry straight through.
 */
export function generateView(screen, root = process.cwd()) {
  for (const field of ['name', 'entry', 'designDir', 'outDir']) {
    if (!screen[field]) throw new Error(`screen ${screen.name ?? '?'} is missing "${field}"`);
  }
  resetState();

  const name = screen.name;
  const label = screen.screenLabel ?? name;
  const designDir = relative(root, resolve(root, screen.designDir));
  const outDir = relative(root, resolve(root, screen.outDir));
  const srcRel = `${designDir}/${screen.entry}`;
  const SRC = resolve(root, srcRel);
  const OUT = resolve(root, outDir, `${name}ScreenView.tsx`);
  const BINDINGS_OUT = resolve(root, outDir, 'bindings.generated.ts');
  const INERT_OUT = resolve(root, outDir, 'bindings.inert.generated.ts');
  const HEADER_OUT = resolve(root, outDir, `${name}HeaderView.tsx`);

  // The design folder has to live under the screen's own folder, because the
  // generated view imports its assets with a relative path.
  if (!designDir.startsWith(`${outDir}/`)) {
    throw new Error(`screen ${name}: designDir ${designDir} must sit inside outDir ${outDir}`);
  }
  assetBase = `./${designDir.slice(outDir.length + 1)}`;
  designDirAbs = resolve(root, designDir);

  const type = `${name}Bindings`;
  const namesConst = `${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_BINDING_NAMES`;
  const wiring = `use${name}Bindings`;

  const file = readFileSync(SRC, 'utf8');

  const startMarker = `<div data-screen-label="${label}"`;
  const start = file.indexOf(startMarker);
  if (start === -1) throw new Error('screen root not found in ' + SRC);
  // Claude Design sometimes writes `</div></x-dc>` on one line; accept both.
  let end = file.indexOf('\n</x-dc>');
  if (end === -1) end = file.indexOf('</x-dc>');
  if (end === -1) throw new Error('</x-dc> not found in ' + SRC);
  const markup = file.slice(start, end);

  const ast = parse(markup);

  // Contract 1: the parse is lossless.
  const round = serialize(ast);
  if (round !== markup) {
    let k = 0;
    while (k < Math.min(round.length, markup.length) && round[k] === markup[k]) k++;
    throw new Error(
      `round-trip mismatch at offset ${k}\n  input: ${JSON.stringify(markup.slice(k - 60, k + 60))}\n  output: ${JSON.stringify(round.slice(k - 60, k + 60))}`,
    );
  }

  const body = emitChildren(ast, new Set(), 2);

  // The design's dark top bar is the app frame, not a Sales ornament: every space
  // wears it. Emit the <header> subtree as its own component so the other spaces
  // reuse this exact generated markup instead of a hand-copied duplicate that
  // would drift the moment the design changes. Only the screen that owns the bar
  // declares `header: true`; the rest have no <header> and must not fail for it.
  const findHeader = (node) => {
    if (node.type === 'element' && node.name === 'header') return node;
    for (const child of node.children ?? []) {
      const hit = findHeader(child);
      if (hit) return hit;
    }
    return null;
  };
  let headerBody = null;
  let headerAssets = [];
  if (screen.header) {
    const headerNode = findHeader(ast);
    if (!headerNode) throw new Error('no <header> found in the design markup');
    // The header file imports only the assets its own subtree references.
    const bodyAssets = [...usedAssets];
    usedAssets.clear();
    headerBody = emitNode(headerNode, new Set(), 2);
    headerAssets = [...usedAssets];
    for (const a of bodyAssets) usedAssets.add(a);
  }

  // Contract 2: every style string survived, with its literal text byte-for-byte
  // and its bindings in the same positions. Both sides are normalised by punching
  // each interpolation down to one sentinel character, then compared as multisets,
  // so a dropped, reordered or edited declaration cannot pass.
  const HOLE = '\u0000';

  const wantStyles = [...markup.matchAll(/\sstyle="([^"]*)"/g)]
    .map((m) => m[1].replace(/\{\{[^}]*\}\}/g, HOLE))
    .sort();

  const gotStyles = extractCallArgs(body, 'dcStyle')
    .map((arg) => {
      if (!arg.startsWith('`')) return HOLE; // sole binding, e.g. dcStyle(v.foo)
      return arg
        .slice(1, -1)
        .replace(/\$\{[^}]*\}/g, HOLE)
        .replace(/\\\$\{/g, '${')
        .replace(/\\`/g, '`')
        .replace(/\\\\/g, '\\');
    })
    .sort();

  if (wantStyles.length !== gotStyles.length) {
    throw new Error(`style count mismatch: design has ${wantStyles.length}, emit has ${gotStyles.length}`);
  }
  for (let n = 0; n < wantStyles.length; n++) {
    if (wantStyles[n] !== gotStyles[n]) {
      throw new Error(
        `style mismatch at sorted index ${n}\n  design: ${JSON.stringify(wantStyles[n])}\n  emit:   ${JSON.stringify(gotStyles[n])}`,
      );
    }
  }

  // Import only the runtime helpers a file actually calls. A screen with no
  // hover rules never calls dcState, and an unused import fails a strict
  // tsc (noUnusedLocals). Sales uses all four, so its output is unchanged.
  const runtimeImports = (code) => {
    const lines = [];
    if (code.includes('<Fragment')) lines.push(`import { Fragment } from 'react';`);
    const used = ['dcStyle', 'dcState', 'dcList', 'dcKey'].filter((n) => code.includes(`${n}(`));
    if (used.length) lines.push(`import { ${used.join(', ')} } from './dcRuntime';`);
    return lines.join('\n');
  };
  const importsFor = (assets) => assets.map((a) => `import ${assetIdent(a)} from '${assetBase}/${a}';`).join('\n');
  const assetImports = importsFor([...usedAssets]);

  const BANNER = `// GENERATED by the design skill (dc-to-view.mjs) from ${srcRel}
// Do not edit by hand. Edit the design in Claude Design, then: npm run design`;

  const out = `${BANNER}
//
// Every inline style string below is a byte-for-byte copy of the design source.
${runtimeImports(body)}
import type { ${type} } from './bindings.generated';
${assetImports}

export function ${name}ScreenView({ v }: { v: ${type} }) {
  return (
    <>
${body}    </>
  );
}
`;

  // The set of bindings the design actually reads. Emitting it as a required
  // interface means the wiring layer cannot silently forget one: a missing
  // binding is a type error, not a blank patch of screen.
  const roots = [...new Set([...body.matchAll(/\bv\.([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) => m[1]))].sort();

  const bindingsOut = `${BANNER}
//
// One entry per binding the design reads. Values are intentionally loose here —
// the real types live in the hand-written wiring that produces them. What this
// file enforces is COMPLETENESS: every binding the design uses must be supplied.

export interface ${type} {
${roots.map((r) => `  ${r}: any;`).join('\n')}
}

/** Every binding name the design reads, for runtime completeness checks. */
export const ${namesConst} = ${JSON.stringify(roots, null, 2).replace(/\n/g, '\n')} as const;
`;

  // The inert default for every binding, shaped by how the markup uses it. This
  // is what makes completeness structural: the wiring spreads over these, so a
  // binding nobody has got to yet renders as an honest empty rather than crashing
  // the screen, and TypeScript still rejects a name that does not exist.
  const inertFor = (bindingName) => {
    if (USE.list.has(bindingName)) return '[]';
    if (USE.cond.has(bindingName)) return 'false';
    if (USE.handler.has(bindingName)) return 'NOOP';
    if (USE.ref.has(bindingName)) return 'undefined';
    return "''";
  };

  const inertOut = `${BANNER}
//
// The inert value of every binding the design reads, shaped by how the markup
// uses it: a list the markup iterates defaults to [], a condition to false, an
// event handler to a no-op, everything else to an empty string.
//
// The wiring in ${wiring} spreads over this, so a region nobody has
// wired yet renders empty instead of throwing, and no binding can be forgotten.
import type { ${type} } from './bindings.generated';

const NOOP = () => {};

export const INERT_BINDINGS: ${type} = {
${roots.map((r) => `  ${r}: ${inertFor(r)},`).join('\n')}
};
`;

  const files = [[OUT, out], [BINDINGS_OUT, bindingsOut], [INERT_OUT, inertOut]];

  if (headerBody !== null) {
    files.push([HEADER_OUT, `${BANNER}
//
// The design's top bar, emitted on its own so every space can wear it. This is
// the same markup the ${name} screen renders, from the same source, so the bar
// cannot drift between spaces.
${runtimeImports(headerBody)}
import type { ${type} } from './bindings.generated';
${importsFor(headerAssets)}

export function ${name}HeaderView({ v }: { v: ${type} }) {
  return (
    <>
${headerBody}    </>
  );
}
`]);
  }

  // --logic: also emit the design's own logic class as a module, so a space the
  // app runs exactly as designed (class-mode style) can host it. The class is
  // copied verbatim; only a minimal DCLogic base and React are supplied.
  if (screen.logic) {
    const sm = /<script[^>]*type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/.exec(file);
    if (!sm || !/class\s+Component\s+extends\s+DCLogic/.test(sm[1])) throw new Error(`screen ${name}: --logic but no "class Component extends DCLogic" script`);
    const LOGIC_OUT = resolve(root, outDir, `${name}Logic.generated.js`);
    const LOGIC_DTS = resolve(root, outDir, `${name}Logic.generated.d.ts`);
    files.push([LOGIC_OUT, `// GENERATED by the design skill (dc-to-view.mjs --logic) from ${srcRel}
// Do not edit by hand. Edit the design in Claude Design, then: npm run design
//
// The design's logic class, verbatim. The host supplies state plumbing through
// __host (setState) and __force (forceUpdate).
/* eslint-disable */
// @ts-nocheck
import * as React from 'react';

class DCLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(update, cb) { if (this.__host) this.__host(update, cb); }
  forceUpdate() { if (this.__force) this.__force(); }
  componentDidMount() {}
  componentDidUpdate() {}
  componentWillUnmount() {}
  renderVals() { return {}; }
}
${sm[1].trim()}

export default Component;
`]);
    files.push([LOGIC_DTS, `// GENERATED by the design skill (dc-to-view.mjs --logic). Do not edit by hand.
declare const Component: new (props?: Record<string, unknown>) => any;
export default Component;
`]);
  }

  console.log(`[${name}] round-trip OK (${markup.length} bytes)`);
  console.log(`[${name}] styles verified: ${wantStyles.length}`);
  console.log(`[${name}] state-style rules: ${hoverCount}`);
  console.log(`[${name}] bindings: ${roots.length}`);
  console.log(`[${name}] emitted: ${out.split('\n').length} lines`);

  return files;
}

/** Pulls the single argument out of every `name(...)` call, respecting backticks. */
function extractCallArgs(source, name) {
  const out = [];
  const needle = name + '(';
  let at = 0;
  for (;;) {
    const k = source.indexOf(needle, at);
    if (k === -1) return out;
    let p = k + needle.length;
    let depth = 1;
    let tick = false;
    const startArg = p;
    while (p < source.length && depth > 0) {
      const c = source[p];
      if (tick) {
        if (c === '\\') p++;
        else if (c === '`') tick = false;
      } else if (c === '`') tick = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      p++;
    }
    out.push(source.slice(startArg, p - 1).trim());
    at = p;
  }
}

/**
 * Generate one screen and write it, or with `check` compare it against disk.
 * Contract 3: the committed generated files match the design source. Catches a
 * design edit that was pulled but never re-transpiled, and a hand-edit of a
 * generated file. Throws on the first stale or missing file.
 */
export function runView(screen, { root = process.cwd(), check = false, accept = [] } = {}) {
  const files = generateView(screen, root);
  if (check) {
    for (const [path, want] of files) {
      let have;
      try {
        have = readFileSync(path, 'utf8');
      } catch {
        throw new Error('generated file missing, run: npm run design:gen\n  ' + path);
      }
      if (have !== want) {
        throw new Error('generated file is stale, re-run: npm run design:gen\n  ' + path);
      }
    }
    console.log(`[${screen.name}] generated files up to date`);
  } else {
    // Every write goes through the merge guard: a generated file changed by
    // hand since the last run stops the run instead of being overwritten.
    const outDir = resolve(root, screen.outDir);
    const manifestPath = join(outDir, GEN_MANIFEST);
    let base = {};
    if (existsSync(manifestPath)) base = JSON.parse(readFileSync(manifestPath, 'utf8')).files || {};
    const rel = (p) => relative(outDir, p).split(sep).join('/');
    const fingerprints = guardedWrite({ dir: outDir, files: files.map(([p, want]) => [rel(p), want]), base, accept });
    writeFileSync(manifestPath, JSON.stringify({ mode: 'view', screen: screen.name, files: fingerprints }, null, 2) + '\n');
    for (const [path] of files) console.log('wrote ' + relative(root, path));
  }
  return files;
}

/* ---------- CLI ---------------------------------------------------------- */

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i > -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const screen = {
    name: arg('--name'),
    entry: arg('--entry'),
    designDir: arg('--design'),
    outDir: arg('--out'),
    screenLabel: arg('--label'),
    header: argv.includes('--header'),
  };
  for (const [flag, key] of [['--name', 'name'], ['--entry', 'entry'], ['--design', 'designDir'], ['--out', 'outDir']]) {
    if (!screen[key]) {
      console.error(`dc-to-view: ${flag} is required`);
      process.exit(1);
    }
  }
  try {
    const accept = (arg('--accept') || '').split(',').map((x) => x.trim()).filter(Boolean);
    runView(screen, { check: argv.includes('--check'), accept });
  } catch (e) {
    console.error(`dc-to-view: ${e.message}`);
    process.exit(1);
  }
}
