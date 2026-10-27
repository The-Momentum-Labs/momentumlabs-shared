/**
 * Capture a rendered page as a Claude Design `.dc.html` file.
 *
 * The whole idea: never read source. The browser has already resolved React,
 * Tailwind, cva and every CSS variable into plain elements plus plain CSS rules.
 * That output has the same shape for every repo and every framework, which is
 * what makes one script enough for all of them.
 *
 * Critically we ship the page's generated stylesheets alongside the markup rather
 * than flattening styles into inline values. That keeps class names and CSS
 * custom properties intact, so `--brand` and the `.dark` block survive the trip
 * and an edit coming back can still be attributed to a token rather than to an
 * anonymous hex.
 *
 * Usage:
 *   node capture.mjs --url <page> --out <file.dc.html> [--state <storageState>]
 *                    [--label <name>] [--width 1440] [--height 900] [--wait 6000]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/**
 * Serve a built bundle to the page straight off disk, with no server process.
 *
 * file:// cannot load ES modules (the browser treats every file as its own
 * opaque origin), and running an actual static server is not available here.
 * Intercepting requests inside the browser gives a real http origin, so
 * modules, fonts and stylesheets all resolve exactly as they would in
 * production, while nothing is listening on a port.
 */
export async function serveDirFromDisk(page, dir, origin = 'http://harness.local') {
  const root = path.resolve(dir);
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({
      status: 200,
      contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      body: fs.readFileSync(file),
    });
  });
}

/** Playwright lives in the target repo, not next to this script. */
function loadChromium(repoDir) {
  const require = createRequire(path.join(repoDir, 'package.json'));
  return require('@playwright/test').chromium;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Pull the rendered markup and every stylesheet the browser could read.
 *
 * Same-origin sheets expose `cssRules`, so we serialize them verbatim. A
 * cross-origin sheet (a font CDN, typically) throws on access, so we keep its
 * original <link> and let the published page fetch it the same way the real one
 * does. Either way nothing is reinvented.
 */
async function extract(page) {
  return page.evaluate(() => {
    const links = [];
    const kept = [];
    let seen = 0;

    /**
     * Tailwind ships one class per utility, so a real page uses a small
     * fraction of the generated bundle. Keeping all of it would bloat the
     * design file into something unopenable and drown the rules that matter.
     * So we keep a style rule only when its selector actually matches
     * something on this page.
     *
     * `:root` and `html` rules are kept unconditionally: that is where the
     * design tokens live, and losing them would flatten every color to
     * nothing. Pseudo-classes are stripped before matching, because
     * `.btn:hover` never matches at rest but its rule still has to travel
     * for the hover state to exist at all.
     */
    const selectorMatches = (selector) => {
      if (!selector) return false;
      if (/^(:root|html)\b/.test(selector.trim())) return true;
      return selector.split(',').some((part) => {
        const probe = part
          .replace(/::?[a-z-]+(\([^)]*\))?/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!probe) return false;
        try {
          return document.querySelector(probe) !== null;
        } catch {
          return false;
        }
      });
    };

    const walk = (rules, out) => {
      for (const rule of Array.from(rules)) {
        seen++;
        // Style rule
        if (rule.type === 1) {
          if (selectorMatches(rule.selectorText)) out.push(rule.cssText);
          continue;
        }
        // @media / @supports / @layer: filter the inside, drop if it empties
        if (rule.cssRules && (rule.type === 4 || rule.type === 12 || rule.constructor?.name === 'CSSLayerBlockRule')) {
          const inner = [];
          walk(rule.cssRules, inner);
          if (inner.length) {
            const cond = rule.conditionText ?? rule.media?.mediaText ?? '';
            const at = rule.type === 4 ? '@media' : rule.type === 12 ? '@supports' : '@layer';
            out.push(`${at} ${cond} {\n${inner.join('\n')}\n}`);
          }
          continue;
        }
        // @font-face, @keyframes, @property and friends travel as-is: they
        // define resources the kept rules reference by name.
        if (rule.type === 5 || rule.type === 7 || rule.constructor?.name === 'CSSPropertyRule') {
          out.push(rule.cssText);
        }
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules, kept);
      } catch {
        if (sheet.href) links.push(sheet.href);
      }
    }

    return {
      html: document.body.innerHTML,
      css: kept.join('\n'),
      links,
      rulesSeen: seen,
      rulesKept: kept.length,
      rootClass: document.documentElement.className || '',
      bodyClass: document.body.className || '',
      lang: document.documentElement.lang || 'en',
      title: document.title,
      bg: getComputedStyle(document.body).backgroundColor,
    };
  });
}

/**
 * Wrap the captured page in the `.dc.html` shape Claude Design's editor needs.
 *
 * Requirements taken from its own spec: markup lives inside <x-dc>, <helmet>
 * comes first and carries the styles, support.js is loaded from a sibling path,
 * and top-level screens carry [data-screen-label] so editor comments can name
 * them. The original <html> and <body> class strings are re-applied to a wrapper
 * div, because the theme (`.dark`) and any global classes hang off them and would
 * otherwise be lost.
 */
function toDcHtml({ html, css, links, rootClass, bodyClass, bg, label, width, height }) {
  const linkTags = links.map((h) => `      <link rel="stylesheet" href="${escapeAttr(h)}" />`).join('\n');
  const wrapperClass = [rootClass, bodyClass].filter(Boolean).join(' ');

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="./support.js"></script>
  </head>
  <body>
    <x-dc>
      <helmet data-dc-atomics>
${linkTags}
        <style>
${css}
        </style>
      </helmet>
      <div class="${escapeAttr(wrapperClass)}" data-screen-label="${escapeAttr(label)}" style="min-height:100vh;background:${escapeAttr(bg)}">
${html}
      </div>
    </x-dc>
    <script
      type="text/x-dc"
      data-dc-script
      data-props='{"$preview":{"width":${width},"height":${height}}}'
    >
      class Component extends DCLogic {
        renderVals() { return {}; }
      }
    </script>
  </body>
</html>
`;
}

/**
 * Snapshot a page that is already open and write the .dc.html.
 * The walker uses this on each screen it lands on, so a walk and a one-off
 * capture produce byte-identical output from the same code path.
 */
export async function snapshotToFile(page, out, { label, width = 1440, height = 900 } = {}) {
  const data = await extract(page);
  const doc = toDcHtml({
    ...data,
    label: label || data.title || 'Screen',
    width: Number(width),
    height: Number(height),
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, doc);
  return {
    out,
    bytes: doc.length,
    htmlBytes: data.html.length,
    cssBytes: data.css.length,
    rulesKept: data.rulesKept,
    rulesSeen: data.rulesSeen,
    externalSheets: data.links.length,
  };
}

export async function capture({
  url,
  out,
  state,
  label,
  repoDir = process.cwd(),
  width = 1440,
  height = 900,
  wait = 6000,
  shot,
  serve,
}) {
  const chromium = loadChromium(repoDir);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: Number(width), height: Number(height) },
    ...(state ? { storageState: state } : {}),
  });
  const page = await ctx.newPage();

  if (serve) await serveDirFromDisk(page, serve);

  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(Number(wait));

  const data = await extract(page);
  const finalUrl = page.url();

  if (shot) {
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
  }

  await browser.close();

  const doc = toDcHtml({
    ...data,
    label: label || data.title || 'Screen',
    width: Number(width),
    height: Number(height),
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, doc);

  return {
    out,
    finalUrl,
    bytes: doc.length,
    htmlBytes: data.html.length,
    cssBytes: data.css.length,
    externalSheets: data.links.length,
    rulesKept: data.rulesKept,
    rulesSeen: data.rulesSeen,
    consoleErrors,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    console.error('usage: node capture.mjs --url <page> --out <file.dc.html> [--state <f>] [--label <n>] [--shot <png>]');
    process.exit(2);
  }
  capture(args)
    .then((r) => {
      console.log(`out       ${r.out}`);
      console.log(`final url ${r.finalUrl}`);
      console.log(`html      ${r.htmlBytes} bytes`);
      console.log(`css       ${r.cssBytes} bytes`);
      console.log(`ext sheets ${r.externalSheets}`);
      console.log(`css rules ${r.rulesKept} kept of ${r.rulesSeen}`);
      console.log(`total     ${r.bytes} bytes`);
      console.log(`console errors ${r.consoleErrors.length}`);
      r.consoleErrors.slice(0, 3).forEach((e) => console.log('  !', e));
    })
    .catch((e) => {
      console.error(String(e.stack || e.message || e));
      process.exit(1);
    });
}
