/**
 * dc-gen-astro.mjs — the astro half of the generator.
 *
 * `dc-gen.mjs` detects the target and hands off to here when the design bundle
 * is a folder of plain static pages rather than a .dc.html component. The two
 * drivers have genuinely different shapes and that is why they are separate
 * files:
 *
 *   react   one entry component, which imports other components. One tree.
 *   astro   N independent pages that link to each other. The set of pages IS
 *           the route table, so it has to be discovered before any page is
 *           converted, or the links cannot be rewritten.
 *
 * Two deliberate differences from the react driver:
 *
 *   It does not wipe --out. The react driver owns its whole generated/ folder
 *   and rebuilds it so a deleted component stops existing. An astro site's
 *   pages land in src/pages/, next to hand-written routes and an api/ folder,
 *   and deleting those would be destroying work nobody asked to destroy. This
 *   writes the pages it generates, nothing else, and records them in
 *   MANIFEST.json so the set it owns is always visible.
 *
 *   It takes a --config. Only the repo knows where its images ended up or which
 *   stylesheet a design bundle's hashed css corresponds to. Guessing that is
 *   how a converter silently points a page at the wrong file, so the mappings
 *   are declared by the repo and anything missing from them is reported.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, basename, posix, sep } from 'node:path';
import { sha256, planWrites } from './merge-guard.mjs';

/* ---------- page discovery ----------------------------------------------- */

/**
 * The pages of a bundle, in a stable order, with the backup and partial files
 * that live beside them left out.
 *
 * A real example of why this is not just "every .html file": project 3a7044d4
 * holds `recruiting.v1.html`, which is a hand-kept backup of the previous
 * recruiting page. It is a complete document, so it detects as astro, and
 * shipping it would publish a dead page at /recruiting.v1.
 *
 * @param {string[]} files  every filename in the bundle directory
 * @param {string[]} skip   filenames the caller excludes, verbatim
 */
export function discoverPages(files) {
  return files
    .filter((f) => f.endsWith('.html'))
    // A dotted stem is a variant of another page, not a page: recruiting.v1,
    // index.old, team.backup. A real route is one word.
    .filter((f) => !/\./.test(f.replace(/\.html$/, '')))
    .sort();
}

/**
 * The url a page file is served at. `index.html` is the site root; everything
 * else drops its extension. Astro's own file-based routing does exactly this,
 * so the generated filename and the rewritten link agree by construction.
 */
export function routeFor(file) {
  const name = file.replace(/\.html$/, '');
  if (name === 'index') return '/';
  // A folder's own index is that folder, the same way the top index is /.
  if (name.endsWith('/index')) return '/' + name.slice(0, -'/index'.length);
  return '/' + name;
}

/* ---------- public manifest ---------------------------------------------- */

/**
 * Every file under a directory, as paths relative to it with forward slashes.
 * Used to answer "does `fonts/newsreader-latin.woff2` really exist in public/",
 * so a missing asset is reported instead of being rewritten to a 404.
 */
export function listFiles(root, prefix = '') {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const rel = prefix ? posix.join(prefix, name) : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/* ---------- stylesheets -------------------------------------------------- */

/**
 * Copy the design bundle's own stylesheets into the repo and return the import
 * path for each, keyed by the stem `dc-to-astro.mjs` looks them up under.
 *
 * The design pages link a built bundle whose name carries a content hash, for
 * example `_astro/careers.DbjjxZPV.css`. That exact filename will not exist in
 * this build, so the link cannot survive. Vendoring the bytes and importing
 * them means the css comes from the design too: the page, its behavior and its
 * styling all refresh together on a re-pull, and there is no second copy of the
 * stylesheet in the repo to drift out of sync.
 *
 * Config shape:
 *   stylesOut  "src/styles/design"        where the copies go
 *   styles     { careers: "site.css" }    design stem -> filename to write
 */
export async function vendorStylesheets({ cfg, pagesDir, out, publicFiles, log = console.log, defer = false }) {
  const { rewriteCssUrls } = await import('./dc-to-astro.mjs');
  const styles = cfg.styles || {};
  const stylesOut = cfg.stylesOut;
  const importPaths = {};
  const copied = [];
  const cssUnportable = [];
  // With defer, nothing touches disk here: the caller runs the merge guard over
  // every planned write first and only then writes.
  const writes = [];

  if (!stylesOut || Object.keys(styles).length === 0) return { importPaths, copied, unportable: cssUnportable, writes };

  mkdirSync(stylesOut, { recursive: true });

  // Index the bundle's stylesheets by stem so the content hash never has to be
  // written into the config, where it would go stale on the next design deploy.
  const found = new Map();
  for (const rel of listFiles(pagesDir)) {
    if (!rel.endsWith('.css')) continue;
    found.set(basename(rel).split('.')[0], rel);
  }

  for (const [stem, filename] of Object.entries(styles)) {
    const rel = found.get(stem);
    if (!rel) {
      log(`  stylesheet "${stem}" is in the config but not in the bundle, skipped`);
      continue;
    }
    const dest = join(stylesOut, filename);
    // The stylesheet's url() paths are relative to where it sat in the bundle,
    // and it is about to sit somewhere else. Resolve them from its old home.
    const r = rewriteCssUrls(readFileSync(join(pagesDir, rel), 'utf8'), dirname(rel), {
      publicFiles,
      assets: cfg.assets || {},
    });
    if (defer) writes.push({ dest, body: r.css });
    else writeFileSync(dest, r.css);
    copied.push({
      stem, from: rel, to: relative(process.cwd(), dest),
      urlsRewritten: r.rewritten, unportable: r.unportable, sha256: sha256(r.css),
    });
    for (const u of r.unportable) cssUnportable.push({ file: rel, ...u });
    // An Astro frontmatter import resolves from the page's own directory, so
    // the path has to be relative to --out, not to the repo root. posix
    // separators: this string goes into source code, not onto a filesystem.
    importPaths[stem] = './' + relative(out, dest).split(sep).join('/');
  }

  return { importPaths, copied, stylesOut, unportable: cssUnportable, writes };
}

/* ---------- banner ------------------------------------------------------- */

/**
 * Astro frontmatter is JavaScript, not markup, so the banner is a JS block
 * comment. An html comment here is a syntax error: esbuild reports
 * `Expected ";" but found "FILE"` on the second line and the build stops.
 */
const BANNER = (source, designDir) => `---
/**
 * GENERATED FILE. DO NOT EDIT.
 *
 * Source: ${designDir}/${source}
 * Written by the design skill's dc-gen.mjs (astro target). Re-run the repo's
 * design:gen script after a pull.
 *
 * A hand edit here STOPS the next run: the generator compares this file to
 * the fingerprint it recorded in _generated-manifest.json and refuses to
 * overwrite a change it did not make. Put the change in Claude Design, or
 * change the converter in @momentumlabs/shared design/scripts/dc-to-astro.mjs,
 * or pass --accept <file> to let the design win for this file.
 */
`;

/* ---------- merge guard -------------------------------------------------- */

// The guard itself lives in merge-guard.mjs, shared by every path; re-exported
// here so callers and tests that import it from the astro driver keep working.
export { sha256, planWrites };

/** base map from the previous manifest: out-relative path -> sha256. */
function recordedFingerprints(out, cfg) {
  const file = join(out, '_generated-manifest.json');
  if (!existsSync(file)) return {};
  let m;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  const base = {};
  for (const p of m.pages || []) if (p.sha256) base[p.file] = p.sha256;
  for (const s of m.stylesheets || []) {
    // Stylesheets are recorded by their repo-relative `to`; the guard keys
    // everything by its path relative to --out.
    if (s.sha256 && s.to) base[relative(out, join(process.cwd(), s.to)).split(sep).join('/')] = s.sha256;
  }
  return base;
}

/* ---------- run ---------------------------------------------------------- */

/**
 * @param {object} a
 * @param {string} a.design   the pulled bundle directory
 * @param {string} a.out      where the .astro pages go, usually src/pages
 * @param {string} a.entry    the primary page, relative to `design`
 * @param {string} [a.config] json with { assets, styles, frontmatter, skip }
 * @param {string} [a.publicDir]  the repo's public/ directory
 * @param {string[]} [a.skip]  page filenames to leave out
 * @param {string[]} [a.accept]  out-relative files the design may overwrite despite a hand edit
 * @param {Function} [a.log]
 */
export async function run({ design, out, entry, config, publicDir, skip = [], accept = [], log = console.log }) {
  const { convert } = await import('./dc-to-astro.mjs');
  const { detect } = await import('./dc-detect.mjs');

  // The entry names the page, and its folder is the bundle of pages. A static
  // site is its whole page set, not one screen.
  const pagesDir = join(design, dirname(entry));
  if (!existsSync(join(design, entry))) {
    throw new Error(`dc-gen-astro: ${entry} is not in ${design}. Run the pull first.`);
  }

  const cfg = config && existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : {};
  const skipAll = new Set([...skip, ...(cfg.skip || [])]);

  /**
   * Every page in the bundle, which IS the route table. Skipping is about not
   * GENERATING a page, never about forgetting it exists: /events is hand-written
   * here because it renders live data, and if it dropped out of this map then
   * the nav link to it on all eight other pages would be reported unportable.
   */
  // listFiles, not readdirSync: a route can have a slash in it.
  // cypfounders.com serves /programs/brunch-events, and a bundle read one
  // level deep could not hold that page at all.
  const allPages = discoverPages(listFiles(pagesDir));
  if (!allPages.includes(basename(entry))) allPages.push(basename(entry));
  const routes = Object.fromEntries(allPages.map((f) => [f, routeFor(f)]));

  /**
   * What the deployed site really serves. public/ is most of it, plus whatever
   * the config declares as emitted at build time: @astrojs/sitemap writes
   * sitemap-index.xml during the build, so it is served at / but is not a file
   * in public/. Declared rather than inferred, because the alternative is
   * assuming any missing file is probably fine.
   */
  const publicFiles = new Set([...listFiles(publicDir), ...(cfg.buildEmitted || [])]);

  const written = [];
  const unportableAll = [];
  const skippedPages = [];

  mkdirSync(out, { recursive: true });

  // Design stylesheets are vendored on every run, so the design owns the css
  // too and a re-pull refreshes it. Without this the pages would import a
  // hand-maintained stylesheet that can drift from the design.
  const vendored = await vendorStylesheets({ cfg, pagesDir, out, publicFiles, log, defer: true });
  // Every file this run wants to put on disk, held back until the guard has
  // looked at all of them.
  const planned = [...vendored.writes];

  for (const file of allPages) {
    if (skipAll.has(file)) {
      skippedPages.push({ file, reason: 'excluded by --skip or the config' });
      continue;
    }
    const src = readFileSync(join(pagesDir, file), 'utf8');

    // A page the detector does not call astro has no business going through
    // this converter. Report it and move on rather than emitting nonsense.
    const d = detect(src);
    if (d.target !== 'astro') {
      skippedPages.push({ file, reason: d.evidence });
      continue;
    }

    const r = convert(src, {
      routes,
      assets: cfg.assets || {},
      styles: vendored.importPaths,
      publicFiles,
      frontmatter: (cfg.frontmatter || {})[file],
    });

    for (const u of r.unportable) unportableAll.push({ file, ...u });

    const name = file.replace(/\.html$/, '.astro');
    const dest = join(out, name);
    // A nested page needs its folder to exist: src/pages/programs/.
    mkdirSync(dirname(dest), { recursive: true });
    // The banner is a comment, so it goes inside the frontmatter fence that
    // convert() already emitted rather than above it.
    const body = r.code.replace(/^---\n/, BANNER(file, relative(process.cwd(), design)));
    planned.push({ dest, body });
    written.push({ name, route: routes[file], bytes: body.length, sha256: sha256(body), stats: r.stats, imports: r.imports });
  }

  for (const u of vendored.unportable || []) unportableAll.push(u);

  /* ---- the guard ---- */

  const rel = (dest) => relative(out, dest).split(sep).join('/');
  const plan = planWrites({
    writes: planned.map((w) => ({
      path: rel(w.dest),
      body: w.body,
      current: existsSync(w.dest) ? readFileSync(w.dest, 'utf8') : null,
      dest: w.dest,
    })),
    base: recordedFingerprints(out, cfg),
    accept,
  });
  if (plan.conflicts.length) {
    const lines = plan.conflicts.map((c) => `  ${c.path}\n    ${c.reason}`);
    throw new Error(
      `${plan.conflicts.length} file(s) were changed by hand since the last run and the design would overwrite them.\n` +
        `Nothing was written, not even the ${plan.blocked.length} clean file(s).\n` +
        lines.join('\n') +
        `\nEither put the change into Claude Design and pull again, or re-run with\n` +
        `  --accept ${plan.conflicts.map((c) => c.path).join(',')}\n` +
        `to let the design win for exactly those files.`,
    );
  }
  for (const w of plan.toWrite) {
    mkdirSync(dirname(w.dest), { recursive: true });
    writeFileSync(w.dest, w.body);
  }

  const manifest = {
    target: 'astro',
    generatedAt: new Date().toISOString(),
    design: relative(process.cwd(), design),
    entry,
    routes,
    stylesheets: vendored.copied,
    pages: written.map((w) => ({ file: w.name, route: w.route, bytes: w.bytes, sha256: w.sha256 })),
    skipped: skippedPages,
    unportable: unportableAll,
  };
  // Underscore prefix: Astro's file-based router ignores it, so a manifest
  // sitting in src/pages/ cannot become a route.
  writeFileSync(join(out, '_generated-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  /* ---- report ---- */

  log(`generated ${written.length} astro pages into ${relative(process.cwd(), out)}/` +
    (plan.unchanged.length ? ` (${plan.unchanged.length} already matched the design and were left alone)` : ''));
  for (const w of written) {
    const s = w.stats;
    log(
      `  ${w.name.padEnd(18)} ${w.route.padEnd(13)} ` +
        `${String(w.bytes).padStart(6)}b  ` +
        `routes=${s.routes} assets=${s.assets} public=${s.public} ` +
        `css=${s.stylesheets} script=${s.scripts} style=${s.styleTags} ` +
        `srcset-collapsed=${s.srcsetCollapsed} braces=${s.bracesEscaped}`,
    );
  }

  if (skippedPages.length) {
    log(`\npages skipped, not static html:`);
    for (const s of skippedPages) log(`  ${s.file}\n    ${s.reason}`);
  }

  if (unportableAll.length) {
    log(`\nNOT ACCOUNTED FOR BY THE CONFIG: ${unportableAll.length}`);
    for (const u of unportableAll) {
      log(`  ${u.file}: <${u.tag} ${u.attr}="${u.value}">\n    ${u.reason}`);
    }
    log(`  Each one is left exactly as the design wrote it, so it fails visibly.`);
    log(`  Add it to the --config assets/styles map, or put the file in public/.`);
  } else {
    log(`\nevery url accounted for.`);
  }

  return { written, unportable: unportableAll, skipped: skippedPages, manifest };
}
