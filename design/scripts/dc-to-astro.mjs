/**
 * Static html -> .astro converter.
 *
 * The sibling of dc-to-react.mjs, for the other kind of Claude Design project.
 * A design project can hold two different things, and `dc-detect.mjs` decides
 * which one is in front of it:
 *
 *   a .dc.html component  -> dc-to-react.mjs. It has a dc runtime and a logic
 *                            class, so it has to become React to run at all.
 *   a plain html page     -> this file. There is no runtime to host. It is a
 *                            finished document, and the right target is .astro,
 *                            which ships it as prerendered html and keeps the
 *                            head meta, the canonical, the OG tags and the
 *                            JSON-LD that a marketing site lives on.
 *
 * So this converter translates almost nothing. It is a path rewriter and four
 * Astro-specific escapes. That is the point: the design file stays the
 * frontend, byte for byte, and nothing is restyled on the way in.
 *
 * What it actually does, and why each one is needed:
 *
 *   1. urls      A design page links to its siblings as `products.html` and to
 *                its assets as `comet.png`, because in Claude Design it is a
 *                folder of files. In a deployed site those are `/products` and
 *                `/comet.png`.
 *   2. css       The pages reference a built bundle, `_astro/careers.<hash>.css`.
 *                That hash changes on every deploy, so the link cannot be kept.
 *                The stylesheet becomes a frontmatter `import`, which lets
 *                Astro hash it itself and, unlike a hand-written <link>, has a
 *                deterministic position in the cascade.
 *   3. script    Astro bundles and rewrites <script> in a page. The design's
 *                behavior has to ship exactly as written, so every script gets
 *                `is:inline`.
 *   4. style     Astro SCOPES <style> in a page by default, which would quietly
 *                break global design css. Every style gets `is:global`.
 *   5. braces    `{` opens an expression in an Astro template. A literal brace
 *                in body text has to be escaped. Inside <script> and <style>
 *                Astro treats the contents as raw text, so those are left
 *                alone, which matters because the scripts are full of braces.
 *
 * Nothing is guessed. A url the caller has not accounted for is recorded as
 * unportable and LEFT AS IT WAS, so a missing asset looks missing instead of
 * resolving to something plausible and wrong.
 */
import { parse, serialize } from 'parse5';
import { posix } from 'node:path';

/* ---------- what counts as a url ----------------------------------------- */

/**
 * Attributes whose value is a single url. Read off the nine real pages:
 * href, src and poster cover everything, and `action` is there for the
 * recruiting form. `content` is deliberately absent: the og:image and
 * canonical values in those files are already absolute, and rewriting meta
 * content by name is how a converter starts mangling text.
 */
const URL_ATTRS = new Set(['href', 'src', 'poster', 'action']);

/** Attributes holding a comma-separated candidate list. */
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

/** Already a destination. Nothing to resolve. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/** `_astro/<stem>.<hash>[_<hash2>].<ext>` as Astro's build emits it. */
const ASTRO_BUILD = /^_astro\/([^/]+?)\.[A-Za-z0-9_-]+\.([a-z0-9]+)$/;

/** Raw-text elements: parse5 does not escape their contents and nor do we. */
const RAW_TEXT = new Set(['script', 'style']);

/** `{{ expr }}`, the same spelling the react converter reads. */
const MUSTACHE = /\{\{([\s\S]*?)\}\}/g;
const hasMustache = (v) => v != null && /\{\{[\s\S]*?\}\}/.test(v);

/**
 * The build-time directives. A design page is a finished document everywhere
 * except where the site has live data, and these two mark those places:
 *
 *   <sc-for list="{{ events }}" as="e" index="i">  one card, repeated
 *   <sc-if cond="{{ hasEvents }}">                 a block that may not show
 *
 * Deliberately the same attribute names the react converter already reads, so a
 * design file does not mean two different things depending on which converter
 * picks it up.
 */
const DIRECTIVES = new Set(['sc-for', 'sc-if']);

/**
 * A character pair that cannot occur in html, used to carry a javascript
 * expression THROUGH parse5's serializer untouched.
 *
 * Needed because the serializer escapes & < > in text and & " in attributes, so
 * an expression written straight into the tree would arrive as `a &amp;&amp; b`
 * and not compile. The expression is parked here and written back after
 * serialization instead.
 */
const HOLE = /\u0001(\d+)\u0001/g;
const ATTR_HOLE = /="\u0001(\d+)\u0001"/g;

/** rewriteUrl names a kind in the singular, the stats counters are plural. */
const KIND_COUNTER = {
  route: 'routes', asset: 'assets', public: 'public', external: 'external',
};

/**
 * Astro directives that are flags, not values. parse5 serializes a valueless
 * attribute as `is:inline=""`, which Astro does accept, but the generated file
 * is read by humans against the design file next to it, so it is written the
 * way the design would write it.
 */
const BOOLEAN_DIRECTIVES = ['is:inline', 'is:global'];

/* ---------- url rewriting ------------------------------------------------ */

/**
 * @param {string} raw   the attribute value as written in the design file
 * @param {object} opts  { routes, assets, styles, publicFiles }
 * @returns {{url: string|null, kind: string, reason?: string}}
 *   `url` is null when nothing in opts accounts for it. The caller leaves the
 *   original value in place and records the miss.
 */
export function rewriteUrl(raw, opts = {}) {
  const value = String(raw ?? '');
  if (!value) return { url: value, kind: 'empty' };
  if (ABSOLUTE.test(value)) return { url: value, kind: 'external' };

  // Split a trailing #hash or ?query so `products.html#ladder` still resolves.
  const cut = value.search(/[#?]/);
  const path = cut === -1 ? value : value.slice(0, cut);
  const tail = cut === -1 ? '' : value.slice(cut);

  const routes = routeMap(opts.routes);
  if (routes.has(path)) return { url: routes.get(path) + tail, kind: 'route' };

  // An .html file that is not one of the bundle's pages. Never invent a route
  // for it: recruiting.v1.html is a real file in the project and is a backup,
  // not a page.
  if (path.endsWith('.html')) {
    return { url: null, kind: 'route', reason: `${path} is not a route in this bundle` };
  }

  const build = ASTRO_BUILD.exec(path);
  if (build) {
    const stem = build[1];
    const mapped = (opts.assets || {})[stem];
    if (mapped) return { url: mapped + tail, kind: 'asset' };
    return {
      url: null,
      kind: 'asset',
      reason: `no asset mapping for "${stem}" (from ${path})`,
    };
  }

  const publicFiles = opts.publicFiles;
  if (publicFiles) {
    const has = typeof publicFiles.has === 'function'
      ? publicFiles.has(path)
      : Object.prototype.hasOwnProperty.call(publicFiles, path);
    if (has) return { url: '/' + path + tail, kind: 'public' };
    return { url: null, kind: 'public', reason: `${path} is not in public/` };
  }

  // No public manifest supplied: the caller is taking responsibility for it.
  return { url: '/' + path + tail, kind: 'public' };
}

function routeMap(routes) {
  const map = new Map();
  if (!routes) return map;
  if (routes instanceof Map) return routes;
  if (Array.isArray(routes)) {
    for (const file of routes) {
      const name = String(file).replace(/\.html$/, '');
      map.set(String(file), name === 'index' ? '/' : '/' + name);
    }
    return map;
  }
  for (const [k, v] of Object.entries(routes)) map.set(k, v);
  return map;
}

/** The stem a stylesheet is keyed by, stable across rebuild hashes. */
export function styleKey(path) {
  const base = path.split('/').pop() || '';
  return base.split('.')[0];
}

/* ---------- css urls ------------------------------------------------------ */

/**
 * Rewrite the `url()` references inside a design stylesheet.
 *
 * A vendored stylesheet moves. In the bundle it sits at `_astro/site.<hash>.css`
 * and says `url(../fonts/newsreader-latin.woff2)`, which resolves to
 * `<bundle>/fonts/...`. Copied to `src/styles/design/site.css` that same string
 * resolves to `src/fonts/...`, which does not exist, and Vite reports
 * "didn't resolve at build time, it will remain unchanged to be resolved at
 * runtime" for every font, then ships a stylesheet whose @font-face rules all
 * 404.
 *
 * So each url is resolved against the stylesheet's ORIGINAL directory in the
 * bundle and then run through the same rewriter the html goes through.
 *
 * @param {string} css
 * @param {string} baseDir  the stylesheet's directory, relative to the bundle
 * @param {object} opts     the same opts convert() takes
 * @returns {{css: string, unportable: object[], rewritten: number}}
 */
export function rewriteCssUrls(css, baseDir, opts = {}) {
  const unportable = [];
  let rewritten = 0;

  const out = String(css).replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (whole, quote, raw) => {
      const value = raw.trim();
      if (!value || ABSOLUTE.test(value)) return whole;
      // posix.join collapses the ../ the stylesheet uses to climb out of _astro.
      const resolved = posix.normalize(posix.join(baseDir || '.', value));
      const r = rewriteUrl(resolved, opts);
      if (r.url === null) {
        unportable.push({ tag: 'css', attr: 'url()', value, reason: r.reason });
        return whole; // left as written, so it fails visibly
      }
      rewritten += 1;
      return `url(${quote}${r.url}${quote})`;
    },
  );

  return { css: out, unportable, rewritten };
}

/* ---------- astro escaping ----------------------------------------------- */

/**
 * `{` opens an expression in an Astro template, so a literal brace in text has
 * to be handed back as a string expression. Only used on text nodes outside
 * <script> and <style>.
 */
export function escapeAstro(text) {
  if (!/[{}]/.test(text)) return text;
  return text.replace(/[{}]/g, (c) => `{'${c}'}`);
}

/* ---------- document split ----------------------------------------------- */

/**
 * Exposed for tests and for a driver that wants the parts without a full
 * conversion. parse5 always produces html > head, body, so this cannot miss.
 */
export function splitDocument(html) {
  const document = parse(String(html));
  const htmlEl = find(document, 'html');
  const head = find(htmlEl, 'head');
  const body = find(htmlEl, 'body');
  return {
    document,
    htmlEl,
    head,
    body,
    htmlAttrs: attrObject(htmlEl),
    bodyAttrs: attrObject(body),
  };
}

function find(node, tagName) {
  for (const child of node?.childNodes || []) {
    if (child.tagName === tagName) return child;
  }
  return null;
}

function attrObject(node) {
  return Object.fromEntries((node?.attrs || []).map((a) => [a.name, a.value]));
}

/* ---------- convert ------------------------------------------------------ */

/**
 * @param {string} html  a complete static html document
 * @param {object} opts
 *   routes       string[] | Record<string,string> — the bundle's page files
 *   assets       Record<stem, url>                — `_astro/<stem>.<hash>.ext`
 *   styles       Record<stem, importPath>         — stylesheet -> frontmatter import
 *   publicFiles  Set<string> | Record<string,*>   — what really exists in public/
 *   frontmatter  string                           — extra lines, after the imports
 * @returns {{code: string, imports: string[], unportable: object[], stats: object}}
 */
export function convert(html, opts = {}) {
  const { document, htmlEl } = splitDocument(html);
  const styles = opts.styles || {};

  const imports = [];
  const unportable = [];
  const stats = {
    routes: 0, assets: 0, public: 0, external: 0,
    stylesheets: 0, scripts: 0, styleTags: 0, srcsetCollapsed: 0, sourcesDropped: 0,
    islands: 0,
    bracesEscaped: 0,
    mustaches: 0, scFor: 0, scIf: 0,
  };

  /**
   * Expressions wait here while parse5 serializes, then go back in verbatim.
   * See HOLE above for why they cannot simply be written into the tree.
   */
  const holes = [];
  const hole = (js) => `\u0001${holes.push(js) - 1}\u0001`;
  /** `{{ a.b }}` and `a.b` both mean the expression. Attributes read better bare. */
  const bareExpr = (v) => {
    const m = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(String(v ?? ''));
    return (m ? m[1] : String(v ?? '')).trim();
  };

  const record = (node, attr, value, reason) => {
    unportable.push({ tag: node.tagName, attr, value, reason });
  };

  /**
   * A local <link rel=stylesheet>. Returns `null` when the node is not one, so
   * the caller can tell "not a stylesheet" from "a stylesheet with no mapping".
   * That distinction matters: a stylesheet href is ALSO an `_astro/<stem>.<hash>`
   * path, so letting an unmapped one fall through to the generic url rewriter
   * reports the same miss twice, once as a stylesheet and once as an image.
   */
  function stylesheetLink(node) {
    if (node.tagName !== 'link') return null;
    const attrs = attrObject(node);
    const rel = (attrs.rel || '').toLowerCase();
    if (!rel.split(/\s+/).includes('stylesheet')) return null;
    const href = attrs.href || '';
    if (ABSOLUTE.test(href)) return null; // a cdn sheet stays a link
    const key = styleKey(href);
    const mapped = styles[key];
    if (!mapped) {
      record(node, 'href', href, `no stylesheet mapping for "${key}" (from ${href})`);
      return { href, import: null };
    }
    return { href, import: mapped };
  }

  /**
   * An attribute whose value is live data. Runs BEFORE the url rewriter, so an
   * `href="{{ e.rsvp }}"` is an expression rather than a path that resolves to
   * nothing. Serialized the value would come back quoted, and `href="{x}"` in
   * Astro is the literal string, so the hole swallows the quotes too (ATTR_HOLE).
   */
  function rewriteMustacheAttrs(node) {
    for (const attr of node.attrs || []) {
      if (!hasMustache(attr.value)) continue;
      const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(attr.value);
      const js = whole
        ? whole[1].trim()
        : '`' + String(attr.value)
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${')
            .replace(MUSTACHE, (_, e) => '${' + e.trim() + '}') + '`';
      attr.value = hole('{' + js + '}');
      stats.mustaches += 1;
    }
  }

  function rewriteAttrs(node) {
    for (const attr of node.attrs || []) {
      if (attr.value && attr.value.includes('\u0001')) continue; // already an expression
      if (SRCSET_ATTRS.has(attr.name)) {
        rewriteSrcset(node, attr);
        continue;
      }
      if (!URL_ATTRS.has(attr.name)) continue;
      const r = rewriteUrl(attr.value, opts);
      if (r.url === null) {
        record(node, attr.name, attr.value, r.reason);
        continue; // leave the original value exactly as it was
      }
      // rewriteUrl reports a singular kind, the counters are plural.
      const counter = KIND_COUNTER[r.kind];
      if (counter) stats[counter] += 1;
      attr.value = r.url;
    }
  }

  /**
   * Astro's build emits one logical image as several hashed variants. Once each
   * candidate resolves through the asset map they all collapse to the same file,
   * which makes the srcset a list of identical urls. Dropping it is what keeps
   * the markup honest; keeping it would advertise widths that do not exist.
   */
  function rewriteSrcset(node, attr) {
    const parts = attr.value.split(',').map((s) => s.trim()).filter(Boolean);
    const resolved = [];
    for (const part of parts) {
      const [url, ...rest] = part.split(/\s+/);
      const r = rewriteUrl(url, opts);
      if (r.url === null) {
        record(node, attr.name, attr.value, r.reason);
        return; // leave the whole attribute alone
      }
      resolved.push({ url: r.url, descriptor: rest.join(' ') });
    }
    const unique = new Set(resolved.map((r) => r.url));
    if (unique.size <= 1) {
      node.attrs = node.attrs.filter((a) => a !== attr);
      stats.srcsetCollapsed += 1;
      /**
       * A <source> exists only to offer an alternative. Once its candidates all
       * resolve to the same file as the <img> next to it, it is offering
       * nothing, and a <source> with no srcset is a dead element the browser
       * steps over. Removing it leaves the <picture> as one honest <img>
       * instead of markup that looks like it does something.
       */
      if (node.tagName === 'source' && !node.attrs.some((a) => a.name === 'src')) {
        node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
        stats.sourcesDropped += 1;
      }
      return;
    }
    attr.value = resolved
      .map((r) => (r.descriptor ? `${r.url} ${r.descriptor}` : r.url))
      .join(', ');
  }

  /* ---- walk ---- */

  const walk = (node, inRawText) => {
    const children = node.childNodes ? [...node.childNodes] : [];

    if (node.nodeName === '#text') {
      if (inRawText) return; // script and style ship exactly as written
      if (hasMustache(node.value)) {
        // Parked first: a hole carries no braces, so the escape below cannot
        // reach inside an expression.
        node.value = node.value.replace(MUSTACHE, (_, e) => {
          stats.mustaches += 1;
          return hole('{' + e.trim() + '}');
        });
      }
      if (/[{}]/.test(node.value)) {
        stats.bracesEscaped += 1;
        node.value = escapeAstro(node.value);
      }
      return;
    }

    /**
     * A build-time directive. The element itself is not markup, it is an
     * instruction, so it is replaced by the expression that wraps its children
     * and never reaches the page. Returns false when the design wrote one
     * without the attribute that gives it meaning: that is reported and the
     * element is left exactly as written, the same rule every other miss in
     * this file follows.
     */
    function unwrapDirective(node, kids) {
      const a = attrObject(node);
      const parent = node.parentNode;
      let open, close;
      if (node.tagName === 'sc-for') {
        const list = bareExpr(a.list);
        if (!list) {
          record(node, 'list', a.list || '', 'sc-for with no list: nothing to repeat');
          return false;
        }
        const as = a.as || 'item';
        const idx = a.index || '__i';
        open = `{(${list} || []).map((${as}, ${idx}) => (<Fragment>`;
        close = '</Fragment>))}';
        stats.scFor += 1;
      } else {
        const cond = bareExpr(a.cond);
        if (!cond) {
          record(node, 'cond', a.cond || '', 'sc-if with no cond: nothing to test');
          return false;
        }
        // Ternary, not &&: `&&` renders a literal 0 for a count of zero.
        open = `{(${cond}) ? (<Fragment>`;
        close = '</Fragment>) : null}';
        stats.scIf += 1;
      }
      const text = (js) => ({ nodeName: '#text', value: hole(js), parentNode: parent });
      for (const k of kids) k.parentNode = parent;
      const at = parent.childNodes.indexOf(node);
      parent.childNodes.splice(at, 1, text(open), ...kids, text(close));
      return true;
    }

    if (node.tagName && DIRECTIVES.has(node.tagName)) {
      if (unwrapDirective(node, children)) {
        for (const child of children) walk(child, inRawText);
        return;
      }
      // Reported. Falls through and is treated as ordinary markup.
    }

    if (node.tagName) {
      /**
       * A captured React island.
       *
       * A design bundle can be a capture of a DEPLOYED page, and if that page
       * rendered a framework component the capture contains the server-rendered
       * markup plus an <astro-island> whose component-url and renderer-url
       * point at hashed javascript bundles from that old build. Those files do
       * not exist here, so the html paints and then hydration 404s and the
       * island never mounts: a page that looks right and is dead.
       *
       * Reported, not repaired. There is no honest automatic fix, because the
       * component is the page's behavior and it lives in this repo, not in the
       * capture. The page belongs on the skip list with its hand-written route
       * kept, which is the caller's decision to make.
       *
       * These urls are not href or src, so the url rewriter never sees them.
       * This is the only reason the check is here.
       */
      if (node.tagName === 'astro-island') {
        const a = attrObject(node);
        record(node, 'component-url', a['component-url'] || '', 
          'a captured framework island: the page was server-rendered from a ' +
          'component and this url is a hashed bundle from that old build, so ' +
          'hydration will 404. Skip this page and keep its hand-written route.');
        stats.islands += 1;
      }

      const sheet = stylesheetLink(node);
      if (sheet) {
        if (sheet.import) {
          if (!imports.includes(sheet.import)) imports.push(sheet.import);
          stats.stylesheets += 1;
          // Drop the link: Astro injects the bundled stylesheet itself, and the
          // design's hashed filename will not exist in this build.
          node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
        }
        // Unmapped: already recorded, and the link stays exactly as it was.
        return;
      }

      rewriteMustacheAttrs(node);
      rewriteAttrs(node);

      if (node.tagName === 'script') {
        stats.scripts += 1;
        if (!node.attrs.some((a) => a.name === 'is:inline')) {
          node.attrs.push({ name: 'is:inline', value: '' });
        }
      } else if (node.tagName === 'style') {
        stats.styleTags += 1;
        if (!node.attrs.some((a) => a.name === 'is:global')) {
          node.attrs.push({ name: 'is:global', value: '' });
        }
      }
    }

    const raw = inRawText || RAW_TEXT.has(node.tagName);
    for (const child of children) walk(child, raw);
  };

  walk(htmlEl, false);

  /* ---- emit ---- */

  const frontmatter = [
    ...imports.map((p) => `import '${p}';`),
    ...(opts.frontmatter ? [String(opts.frontmatter)] : []),
  ].join('\n');

  // parse5 serializes a document with its doctype; serializing the html element
  // alone drops it, so the doctype is written back explicitly. Astro needs it.
  let body = `<!DOCTYPE html>${serialize({ childNodes: [htmlEl] })}`;
  for (const directive of BOOLEAN_DIRECTIVES) {
    body = body.split(` ${directive}=""`).join(` ${directive}`);
  }
  // The expressions go back in now that the serializer can no longer escape
  // them. Attributes first: `href="<hole>"` has to lose its quotes to be an
  // expression rather than the literal string `{e.rsvp}`.
  body = body.replace(ATTR_HOLE, (_, i) => '=' + holes[Number(i)]);
  body = body.replace(HOLE, (_, i) => holes[Number(i)]);
  const code = `---\n${frontmatter ? frontmatter + '\n' : ''}---\n${body}\n`;

  return { code, imports, unportable, stats, document };
}

/**
 * Parity with dc-to-react.mjs, which exports `extractHelmet` for the dc
 * `<helmet>` block. A static page has no helmet: its head IS the head, and it
 * is carried through untouched. Returning null says that explicitly rather
 * than leaving the driver to find out by crashing.
 */
export function extractHelmet() {
  return null;
}
