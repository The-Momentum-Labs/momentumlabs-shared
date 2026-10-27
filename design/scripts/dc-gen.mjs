#!/usr/bin/env node
/**
 * dc-gen.mjs — turn a vendored Claude Design bundle into a React tree.
 *
 * Pairs with design-pull.mjs, which fetches the bundle, and the translators,
 * which do the actual work. Repo-agnostic: every path is an argument.
 *
 *   node dc-gen.mjs --design design/student-portal \
 *                   --entry "AdmissionsOS App v2.dc.html" \
 *                   --out src/pages/student-portal-v2/generated \
 *                   --component DesignApp
 *
 * Paths are relative to the current working directory, so run it from the repo
 * root. A repo records its own arguments in its package.json scripts, or, when
 * it has several screens, once in design.config.json and runs
 * `dc-gen.mjs --manifest design.config.json [--screen <Name>] [--check]`
 * (see manifest.mjs).
 *
 * The FILE picks the target (react or astro, see dc-detect.mjs). For a react
 * target the REPO picks the mode, because the file cannot:
 *
 *   --mode class   (default) dc-to-react.mjs: ports the design's own logic
 *                  class verbatim and emits a component the app subclasses.
 *                  Whole --out folder is rebuilt every run.
 *   --mode view    dc-to-view.mjs: drops the logic class, emits
 *                  <Name>ScreenView({ v }) plus bindings files, the app feeds
 *                  v. Takes --name, and optionally --label, --header, --check.
 *                  Writes four named files into --out and nothing else, so
 *                  hand-written wiring may live beside them.
 *
 * Everything this writes is machine output. Never hand-edit a file under the
 * output directory: the next run overwrites it. Fixes belong in
 * dc-to-react.mjs, which is where they also get a regression test.
 *
 * The seam that makes constant re-pulls safe:
 *   <out>/       markup, styles and the design's own logic class. Disposable.
 *   elsewhere    hand-written data wiring. This script never writes there, so a
 *                re-pull cannot clobber it.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`dc-gen: ${flag} is required`);
  process.exit(1);
}

/** An optional flag. `undefined` when absent, so it can mean "not asked for". */
function argOpt(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/* ---------- manifest: one run per screen --------------------------------- */

{
  const { loadManifest, genArgs, splitManifestArgs, runPerScreen } = await import(join(TOOLS, 'manifest.mjs'));
  const { manifest, only, rest } = splitManifestArgs(process.argv.slice(2));
  if (manifest) {
    let screens;
    try {
      screens = loadManifest(manifest, only);
    } catch (e) {
      console.error(`dc-gen: ${e.message}`);
      process.exit(1);
    }
    process.exit(runPerScreen(fileURLToPath(import.meta.url), 'generating', screens, (s) => genArgs(s), rest));
  }
}

const DESIGN = resolve(process.cwd(), arg('--design'));
const OUT = resolve(process.cwd(), arg('--out'));
/** Fingerprints of the last write, the merge guard's base. Lives in OUT. */
const GEN_MANIFEST = '_generated-manifest.json';
const ENTRY = arg('--entry');
const ENTRY_COMPONENT = arg('--component', 'DesignApp');

/* ---------- which converter ---------------------------------------------- *
 * There are two targets now and the FILE decides, not the caller. A Claude
 * Design project holds either a .dc.html component, which has a dc runtime and
 * a logic class and therefore has to become React, or a folder of finished
 * static pages, which should stay static and become .astro so the head meta and
 * the prerendered output survive.
 *
 * `--target` exists only to pin the choice. When it disagrees with the file,
 * dc-detect throws with the evidence, because a mistranslated page that still
 * compiles is far worse than a run that stops.
 * ------------------------------------------------------------------------- */

const { detect, assertTarget } = await import(join(TOOLS, 'dc-detect.mjs'));

if (!existsSync(join(DESIGN, ENTRY))) {
  console.error(`dc-gen: ${ENTRY} is not in ${relative(process.cwd(), DESIGN)}. Run the pull first.`);
  process.exit(1);
}

const detected = detect(readFileSync(join(DESIGN, ENTRY), 'utf8'));
let TARGET;
try {
  TARGET = assertTarget({
    detected,
    requested: argOpt('--target'),
    file: `${relative(process.cwd(), DESIGN)}/${ENTRY}`,
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`dc-gen: target ${TARGET} (${detected.evidence})`);

/* ---------- mode: class or view, react only ------------------------------ */

const MODE = arg('--mode', 'class');
if (MODE !== 'class' && MODE !== 'view') {
  console.error(`dc-gen: --mode must be class or view, got ${MODE}`);
  process.exit(1);
}
if (MODE === 'view' && TARGET !== 'react') {
  console.error(`dc-gen: --mode view is a react mode; this file is ${TARGET}`);
  process.exit(1);
}

if (MODE === 'view') {
  const { runView } = await import(join(TOOLS, 'dc-to-view.mjs'));
  try {
    runView(
      {
        name: arg('--name'),
        entry: ENTRY,
        designDir: DESIGN,
        outDir: OUT,
        screenLabel: argOpt('--label'),
        header: process.argv.includes('--header'),
        logic: process.argv.includes('--logic'),
      },
      {
        check: process.argv.includes('--check'),
        accept: (argOpt('--accept') || '').split(',').map((s) => s.trim()).filter(Boolean),
      },
    );
  } catch (err) {
    console.error(`dc-gen: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (TARGET === 'astro') {
  const { run } = await import(join(TOOLS, 'dc-gen-astro.mjs'));
  const configPath = argOpt('--config');
  const publicPath = argOpt('--public');
  try {
    await run({
      design: DESIGN,
      out: OUT,
      entry: ENTRY,
      config: configPath ? resolve(process.cwd(), configPath) : undefined,
      publicDir: publicPath ? resolve(process.cwd(), publicPath) : undefined,
      skip: (argOpt('--skip') || '').split(',').map((s) => s.trim()).filter(Boolean),
      // Files, relative to --out, that the design may overwrite even though
      // they were changed by hand since the last run. Named one by one on
      // purpose: there is no --force.
      accept: (argOpt('--accept') || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  } catch (err) {
    console.error(`dc-gen: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

/* ---------- react target ------------------------------------------------- */

const { convert, extractLogic, extractProps, propDefaults } = await import(
  join(TOOLS, 'dc-to-react.mjs')
);

const BANNER = (source) => `/**
 * GENERATED FILE. DO NOT EDIT.
 *
 * Source: ${relative(process.cwd(), DESIGN)}/${source}
 * Written by the design skill's dc-gen.mjs. Re-run \`npm run design:gen\`
 * after a pull.
 *
 * Hand edits here are lost on the next run. Change the design in Claude
 * Design, or change the converter in @momentumlabs/shared design/scripts/.
 */
`;

/**
 * The design's logic class is plain JavaScript, 6000+ lines of it, and it is
 * regenerated wholesale on every pull. Type-checking machine output nobody
 * maintains by hand would block the build for no safety gain; correctness here
 * is held by the converter's own test suite instead. The hand-written data
 * layer next door is fully checked.
 */
const NOCHECK = '// @ts-nocheck\n';

function convertFile(file, componentName) {
  const src = readFileSync(join(DESIGN, file), 'utf8');
  const r = convert(src);
  const logic = extractLogic(src);
  if (!logic) throw new Error(`${file}: no <script type="text/x-dc"> logic class found`);
  if (!/class\s+Component\s+extends\s+(DCLogic|StreamableLogic)\b/.test(logic)) {
    throw new Error(`${file}: logic class is not "class Component extends DCLogic"`);
  }
  if (r.unportable.length) {
    for (const u of r.unportable) unportableAll.push({ file, ...u });
  }
  const defaults = propDefaults(extractProps(src));
  delete defaults.$preview; // editor-only canvas sizing

  const imports = r.importSpecs
    .map((s) => `import ${s.name} from './${s.name}';`)
    .join('\n');

  const body = `${BANNER(file)}${NOCHECK}import React from 'react';
import { __dcStyle } from './logic/runtime';
${imports}

/**
 * Claude Design's support.js calls this base class DCLogic. Its real shape,
 * read out of that file, is React's: constructor(props), this.state,
 * setState(update, cb), forceUpdate(), the three lifecycle hooks, and
 * renderVals() for the view model. So React.Component is a drop-in base and the
 * design's class below is copied across untouched.
 */
class DCLogic extends React.Component {
  renderVals() {
    return {};
  }
}

export const ${componentName}Defaults = ${JSON.stringify(defaults, null, 2)};

/* ------------------------------------------------------------------------- *
 * Verbatim from ${file}. Not rewritten, not reformatted.
 * ------------------------------------------------------------------------- */
${logic}
/* ----------------------------- end verbatim ------------------------------ */

export default class ${componentName} extends Component {
  render() {
    // support.js:1085 merges in exactly this order: props first, then the view
    // model, so renderVals() wins on a name collision.
    const __v = { ...${componentName}Defaults, ...this.props, ...(this.renderVals() || {}) };
    return (
      <React.Fragment>
${r.markup}
      </React.Fragment>
    );
  }
}
`;
  return { body, result: r, logicLines: logic.split('\n').length };
}

/* ---------- run ---------------------------------------------------------- */

if (!existsSync(join(DESIGN, ENTRY))) {
  console.error(`dc-gen: ${ENTRY} is not in ${relative(process.cwd(), DESIGN)}. Run the pull first.`);
  process.exit(1);
}

// The whole directory is rebuilt so a component deleted in Claude Design stops
// existing here too, instead of lingering as a stale file that still compiles.
// The new output is built beside OUT and swapped in through the merge guard,
// so a hand edit in OUT stops the run instead of being wiped with the folder.
const STAGE = OUT + '.dcgen-stage';
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const css = [];
const written = [];
const todo = [];
const unportableAll = [];

const entry = convertFile(ENTRY, ENTRY_COMPONENT);
writeFileSync(join(STAGE, `${ENTRY_COMPONENT}.tsx`), entry.body);
written.push([`${ENTRY_COMPONENT}.tsx`, entry.body.length]);
const styleBlocks = (helmetHtml) =>
  [...helmetHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

css.push(`/* ${ENTRY}: helmet styles */`, styleBlocks(entry.result.helmet));
css.push(`/* ${ENTRY}: ${entry.result.pseudoCss.split('\n').filter(Boolean).length} generated hover and focus rules */`, entry.result.pseudoCss);

// Components the entry imports. Each is the same .dc.html format.
for (const spec of entry.result.importSpecs) {
  if (spec.kind === 'dc-import' && existsSync(join(DESIGN, spec.file))) {
    const c = convertFile(spec.file, spec.name);
    writeFileSync(join(STAGE, `${spec.name}.tsx`), c.body);
    written.push([`${spec.name}.tsx`, c.body.length]);
    css.push(`/* ${spec.file} */`, styleBlocks(c.result.helmet), c.result.pseudoCss);
    continue;
  }

  // Anything else is not a design component we can port. image-slot is Claude
  // Design's own image picker: it writes through window.omelette, which is
  // editor plumbing with no product meaning. Emit a visible placeholder and say
  // so, rather than an invisible no-op that looks like a layout bug.
  todo.push(spec);
  writeFileSync(
    join(STAGE, `${spec.name}.tsx`),
    `${BANNER(ENTRY)}${NOCHECK}import React from 'react';

/**
 * PLACEHOLDER, needs a product decision.
 *
 * The design uses <x-import component-from-global-scope="${spec.raw}">, which is
 * a Claude Design editor tool, not part of the product. It picks images through
 * window.omelette inside their canvas. There is no correct automatic port, so
 * this renders as an obvious unfinished box instead of quietly rendering
 * nothing.
 */
export default function ${spec.name}(props) {
  // The host app can fill a slot with a real image: window.IMAGE_SLOTS[id] =
  // { src, fit? }. Lazy-loaded; a broken image calls window.IMAGE_SLOT_BROKEN(id).
  const slot = typeof window !== 'undefined' && props.id && window.IMAGE_SLOTS ? window.IMAGE_SLOTS[props.id] : null;
  if (slot && slot.src) {
    return (
      <img
        src={slot.src}
        alt={props.placeholder || ''}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => window.IMAGE_SLOT_BROKEN && window.IMAGE_SLOT_BROKEN(props.id)}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          boxSizing: 'border-box',
          background: '#ffffff',
          objectFit: slot.fit || 'cover',
          padding: slot.fit === 'contain' ? 18 : 0,
          borderRadius: props.radius ? Number(props.radius) : 0,
        }}
      />
    );
  }
  return (
    <div
      data-unported="${spec.raw}"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'repeating-linear-gradient(45deg,#f2eee9,#f2eee9 8px,#e8e2da 8px,#e8e2da 16px)',
        border: '1px dashed #b9b2a8',
        borderRadius: props.radius ? Number(props.radius) : 0,
        font: "600 11px/1.3 system-ui, sans-serif",
        color: '#6b6560',
        textAlign: 'center',
        padding: 8,
      }}
    >
      {props.placeholder || '${spec.raw}'} not ported
    </div>
  );
}
`
  );
  written.push([`${spec.name}.tsx`, 0]);
}

mkdirSync(join(STAGE, 'logic'), { recursive: true });
writeFileSync(
  join(STAGE, 'logic/runtime.ts'),
  `${BANNER('(runtime helper)')}/**
 * The design writes styles as css strings and React needs objects. This is
 * cssToObj from Claude Design's support.js (line 391), matched exactly so a
 * generated screen computes the same style object their canvas does. Custom
 * properties keep their name; every other property is camel-cased.
 */
export function __dcStyle(css: unknown): React.CSSProperties {
  if (css == null) return {};
  if (typeof css === 'object') return css as React.CSSProperties;
  const out: Record<string, string> = {};
  for (const decl of String(css).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    if (!prop) continue;
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = decl.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
}
`
);
written.push(['logic/runtime.ts', 0]);

/* ---------- helmet dependencies ------------------------------------------ *
 * The helmet loads the demo data as <script src> globals and the tokens as
 * <link rel=stylesheet>, in an order that matters (research.js reads
 * SCHOOL_FACTS when it is already there). Those files are copied in rather than
 * imported across the repo root, because vite.config.ts denies serving data/**
 * and optimizeDeps only crawls src/**.
 * ------------------------------------------------------------------------- */

/**
 * Not every helmet script is data. Three are runtime code and each needs a
 * decision, so they are named here rather than swept in. Anything unlisted is
 * treated as data and imported for its window globals.
 */
const SCRIPT_SKIP = {
  'support.js': "Claude Design's own template renderer. React replaces it.",
  'image-slot.js':
    'The omelette image picker, an editor tool that writes through window.omelette. Replaced by a marked placeholder component.',
  '_ds_bundle.js':
    'Design-system bundle with an empty components list. Registers a namespace and nothing else.',
};

const helmetSrcs = [];
const skipped = [];
for (const m of entry.result.helmet.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
  const rel = m[1].replace(/^\.\//, '');
  const reason = SCRIPT_SKIP[rel.split('/').pop()];
  if (reason) skipped.push({ rel, reason });
  else helmetSrcs.push(rel);
}

const helmetLinks = [...entry.result.helmet.matchAll(/<link[^>]*\shref="([^"]+)"/g)]
  .map((m) => m[1].replace(/^\.\//, ''));

/**
 * Strip rules that style the host application's mount node.
 *
 * A design bundle's `_ds/reference/` tree is a dump of a repo's own source, so
 * it can carry files that were never design tokens. This one shipped the stock
 * Vite starter `App.css`, whose first rule is:
 *
 *   #root { max-width: 1280px; margin: 0 auto; padding: 2rem; text-align: center; }
 *
 * That rule is inert inside Claude Design's canvas, because nothing there has
 * id="root". In a real React app `#root` is the mount point, so importing it
 * pins the whole product to a centred 1280px column with centred body text.
 *
 * A vendored design stylesheet has no business styling the host's root element
 * under any circumstances, so those rules are removed and named in the output.
 * Scans top-level blocks by brace depth; anything left inside an at-rule is
 * reported rather than quietly rewritten.
 */
function stripHostRootRules(css, rel, report) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) {
      out += css.slice(i);
      break;
    }
    const selector = css.slice(i, open);
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}' && --depth === 0) break;
    }
    const block = css.slice(i, Math.min(end + 1, css.length));
    if (/(^|[\s,>+~])#root\b/.test(selector) && !selector.trim().startsWith('@')) {
      report.push({ rel, selector: selector.trim(), rule: block.replace(/\s+/g, ' ').trim() });
    } else {
      out += block;
    }
    i = end + 1;
  }
  return out;
}

const copied = [];
const unavailable = [];
const strippedRules = [];
for (const rel of [...helmetSrcs, ...helmetLinks]) {
  const from = join(DESIGN, rel);
  if (!existsSync(from)) {
    unavailable.push(rel);
    continue;
  }
  // Flatten to a safe filename: nested paths and spaces both cause trouble.
  const flat = rel.replace(/[\/\s]+/g, '_');
  const dest = join(STAGE, 'deps', flat);
  mkdirSync(dirname(dest), { recursive: true });
  if (rel.endsWith('.css')) {
    writeFileSync(dest, stripHostRootRules(readFileSync(from, 'utf8'), rel, strippedRules));
  } else {
    writeFileSync(dest, readFileSync(from));
  }
  copied.push({ rel, flat, kind: rel.endsWith('.css') ? 'css' : 'js' });
}

// One module whose only job is to run the data files for their side effects, in
// the helmet's order. They each assign to window.*, which is what the design's
// logic class reads.
const dataImports = copied.filter((c) => c.kind === 'js');
writeFileSync(
  join(STAGE, 'logic/designGlobals.ts'),
  `${BANNER('(helmet <script src> list)')}/**
 * The design's demo data. Each file assigns to a window global that the logic
 * class reads, so these are imported for their side effects only, in the order
 * the helmet loads them.
 *
 * Step 6 replaces this module with the real data layer. Nothing else imports it.
 */
${dataImports.map((c) => `import '../deps/${c.flat}';`).join('\n')}

export const DESIGN_DATA_FILES = ${JSON.stringify(dataImports.map((c) => c.rel), null, 2)} as const;
`
);
written.push(['logic/designGlobals.ts', 0]);

const cssImports = copied.filter((c) => c.kind === 'css').map((c) => `@import './deps/${c.flat}';`);
writeFileSync(
  join(STAGE, 'design.css'),
  `/* GENERATED. DO NOT EDIT. See scripts/gen-portal.mjs. */\n\n` +
    `/* Token and motion stylesheets the helmet links, in helmet order. */\n` +
    `${cssImports.join('\n')}\n\n${css.join('\n')}\n`
);
written.push(['design.css', 0]);

{
  const { guardedWrite, walk } = await import(join(TOOLS, 'merge-guard.mjs'));
  const manifestPath = join(OUT, GEN_MANIFEST);
  let base = {};
  if (existsSync(manifestPath)) base = JSON.parse(readFileSync(manifestPath, 'utf8')).files || {};
  try {
    const files = walk(STAGE).map((p) => [p, readFileSync(join(STAGE, p))]);
    const fingerprints = guardedWrite({
      dir: OUT, files, base, removeOthers: true, keep: [GEN_MANIFEST],
      accept: (argOpt('--accept') || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ mode: 'class', entry: ENTRY, files: fingerprints }, null, 2) + '\n');
  } catch (err) {
    rmSync(STAGE, { recursive: true, force: true });
    console.error(`dc-gen: ${err.message}`);
    process.exit(1);
  }
  rmSync(STAGE, { recursive: true, force: true });
}
console.log(`generated ${written.length} files into ${relative(process.cwd(), OUT)}/`);
for (const [f] of written) console.log(`  ${f}`);
console.log(`\nentry: ${ENTRY}`);
console.log(`  ${entry.logicLines} lines of logic class carried over verbatim`);
console.log(`  ${JSON.stringify(entry.result.stats)}`);
if (skipped.length) {
  console.log(`\nhelmet scripts deliberately not imported:`);
  for (const s2 of skipped) console.log(`  ${s2.rel}\n    ${s2.reason}`);
}
console.log(`\nhelmet dependencies copied into generated/deps/: ${copied.length}`);
console.log(`  ${dataImports.length} data globals, ${cssImports.length} stylesheets`);
if (todo.length) {
  console.log(`\nnot ported, rendering as a marked placeholder:`);
  for (const t of todo) console.log(`  <${t.raw}> (${t.kind})`);
}
if (strippedRules.length) {
  console.log(`\nhost-root rules removed from vendored css: ${strippedRules.length}`);
  for (const r of strippedRules) console.log(`  ${r.rel}\n    ${r.rule}`);
  console.log(`  #root is the app's own mount node. A design stylesheet reaching it`);
  console.log(`  pins the whole product to that rule. Inert in Claude Design's canvas.`);
}
if (unportableAll.length) {
  console.log(`\nBROKEN IN THE DESIGN ITSELF, skipped: ${unportableAll.length}`);
  for (const u of unportableAll) {
    console.log(`  ${u.file}: ${u.kind}="${u.value}"`);
  }
  console.log(`  A whole-mustache pseudo style has no stylesheet form. Claude Design`);
  console.log(`  passes it raw to insertRule, so it throws in their canvas too.`);
  console.log(`  Fix at the source: list declarations, e.g. style-hover="background: {{ x }}".`);
}
if (unavailable.length) {
  console.log(`\nreferenced by the helmet but not in design/student-portal/:`);
  for (const u of unavailable) console.log(`  ${u}`);
  console.log(`  (a binary or over-cap file the design API will not serve; see MISSING-BINARIES.txt)`);
}
