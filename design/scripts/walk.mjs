/**
 * Walk a linear wizard, capturing every screen it passes through.
 *
 * The capture engine is app-agnostic, but "visit every screen" never can be:
 * a wizard's screens do not exist until something advances it. So this is the
 * per-app recipe layer. Point it at a start URL, tell it which button advances
 * and which one dismisses a first-run modal, and it walks until it either
 * leaves the flow or hits a step it cannot satisfy.
 *
 * It never invents input. When the advance button is disabled, it reports the
 * app's own reason (the accessible name usually carries it) and stops. That is
 * deliberate: guessing at an answer produces a screen no real user would see,
 * and silently wrong data is worse than a stopped walk.
 *
 * Usage:
 *   node walk.mjs --url <start> --state <storageState> --outdir <dir>
 *                 [--advance "Continue"] [--dismiss "Got it"] [--max 60]
 *                 [--until <url-substring>] [--dark]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

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

const slug = (s) =>
  String(s)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'screen';

/** A short human label for the screen, preferring the question heading. */
async function screenLabel(page) {
  const heading = await page
    .locator('h1, h2, [data-screen-label]')
    .filter({ hasText: /\S/ })
    .last()
    .innerText()
    .catch(() => '');
  const clean = heading.replace(/\s+/g, ' ').trim();
  if (clean && clean.toLowerCase() !== 'admissionsos') return clean.slice(0, 70);
  const t = await page.title();
  return t.slice(0, 70);
}

export async function walk({
  url,
  state,
  outdir,
  advance = 'Continue',
  dismiss = 'Got it',
  until,
  max = 60,
  wait = 3500,
  repoDir = process.cwd(),
  width = 1440,
  height = 900,
  dark = false,
}) {
  const require = createRequire(path.join(repoDir, 'package.json'));
  const { chromium } = require('@playwright/test');
  const { snapshotToFile } = await import(new URL('./capture.mjs', import.meta.url));

  fs.mkdirSync(outdir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: Number(width), height: Number(height) },
    ...(state ? { storageState: state } : {}),
  });
  const page = await ctx.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // First-run modals sit over every screen and would be baked into all of them.
  const modal = page.getByRole('button', { name: new RegExp(dismiss, 'i') });
  if (await modal.count()) {
    await modal.first().click();
    await page.waitForTimeout(2000);
  }

  if (dark) {
    const toggle = page.getByRole('button', { name: /switch to dark mode/i });
    if (await toggle.count()) {
      await toggle.first().click();
      await page.waitForTimeout(1200);
    }
  }

  const visited = [];
  const seen = new Set();
  let blocked = null;

  for (let step = 0; step < Number(max); step++) {
    if (until && page.url().includes(until)) break;

    const label = await screenLabel(page);
    const key = label.toLowerCase();

    // A repeated heading means the flow stopped moving; keep walking would
    // just rewrite the same file forever.
    if (seen.has(key)) {
      blocked = { reason: 'screen repeated, flow is not advancing', label };
      break;
    }
    seen.add(key);

    const stem = `${String(step + 1).padStart(2, '0')}-${slug(label)}`;
    const shot = path.join(outdir, `${stem}.png`);
    const dc = path.join(outdir, `${stem}.dc.html`);

    await page.screenshot({ path: shot });
    // The screenshot is for your eyes; the .dc.html is the deliverable.
    const snap = await snapshotToFile(page, dc, { label, width, height });

    visited.push({ step: step + 1, label, url: page.url(), shot, dc, bytes: snap.bytes });
    console.log(
      `${String(step + 1).padStart(2, '0')}  ${label}` +
        `  [${(snap.bytes / 1024).toFixed(0)}kb, ${snap.rulesKept} rules]`,
    );

    const next = page.getByRole('button', { name: new RegExp(`^${advance}`, 'i') });
    if (!(await next.count())) {
      blocked = { reason: `no "${advance}" button on this screen`, label };
      break;
    }

    // The app states its own precondition in the accessible name. Report it
    // rather than trying to satisfy it by guessing.
    const aria = (await next.first().getAttribute('aria-label')) || '';
    if (await next.first().isDisabled()) {
      blocked = { reason: aria || 'advance button disabled', label };
      break;
    }

    await next.first().click();
    await page.waitForTimeout(Number(wait));
  }

  fs.writeFileSync(path.join(outdir, 'walk.json'), JSON.stringify({ visited, blocked }, null, 2));
  await browser.close();
  return { visited, blocked };
}


/**
 * Capture every screen reachable from a jump/search menu, rather than by
 * advancing a flow.
 *
 * Once a wizard is fully answered, walking it forward is no longer possible:
 * it just completes and redirects. But the screens still exist and are all
 * reachable directly. This visits each menu entry in turn, which also means
 * nothing is written back to the app: we only ever look.
 */
export async function walkJump({
  url,
  state,
  outdir,
  open: openSel = 'Jump to question',
  itemSel = '.picker-panel button',
  dismiss = 'Got it',
  repoDir = process.cwd(),
  width = 1440,
  height = 900,
  wait = 3000,
  dark = false,
  max = 100,
}) {
  const require = createRequire(path.join(repoDir, 'package.json'));
  const { chromium } = require('@playwright/test');
  const { snapshotToFile } = await import(new URL('./capture.mjs', import.meta.url));

  fs.mkdirSync(outdir, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: Number(width), height: Number(height) },
    ...(state ? { storageState: state } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  const modal = page.getByRole('button', { name: new RegExp(dismiss, 'i') });
  if (await modal.count()) {
    await modal.first().click();
    await page.waitForTimeout(2000);
  }

  if (dark) {
    const toggle = page.getByRole('button', { name: /switch to dark mode/i });
    if (await toggle.count()) {
      await toggle.first().click();
      await page.waitForTimeout(1200);
    }
  }

  const openMenu = async () => {
    const btn = page.getByRole('button', { name: new RegExp(openSel, 'i') });
    if (!(await btn.count())) return false;
    await btn.first().click();
    await page.waitForTimeout(1200);
    return true;
  };

  if (!(await openMenu())) {
    await browser.close();
    throw new Error(`no "${openSel}" control on ${page.url()}`);
  }
  const labels = await page.$$eval(itemSel, (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  console.log(`${labels.length} screens in the menu\n`);

  const visited = [];
  const failed = [];

  for (let i = 0; i < Math.min(labels.length, Number(max)); i++) {
    const label = labels[i];
    try {
      if (!(await openMenu())) throw new Error('menu did not open');
      // Exact text match: several questions share opening words.
      const item = page.locator(itemSel).filter({ hasText: label }).first();
      await item.click({ timeout: 8000 });
      await page.waitForTimeout(Number(wait));

      const stem = `${String(i + 1).padStart(2, '0')}-${slug(label)}`;
      await page.screenshot({ path: path.join(outdir, `${stem}.png`) });
      const snap = await snapshotToFile(page, path.join(outdir, `${stem}.dc.html`), { label, width, height });

      visited.push({ i: i + 1, label, dc: `${stem}.dc.html`, bytes: snap.bytes });
      console.log(`${String(i + 1).padStart(2, '0')}  ${label}  [${(snap.bytes / 1024).toFixed(0)}kb]`);
    } catch (e) {
      failed.push({ label, error: String(e.message || e).slice(0, 120) });
      console.log(`${String(i + 1).padStart(2, '0')}  FAILED  ${label}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  fs.writeFileSync(path.join(outdir, 'walk.json'), JSON.stringify({ visited, failed }, null, 2));
  await browser.close();
  return { visited, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.outdir) {
    console.error('usage: node walk.mjs --url <start> --outdir <dir> [--state <f>] [--advance Continue] [--until /portal]');
    process.exit(2);
  }
  const run = args.jump ? walkJump(args) : walk(args);
  run
    .then((r) => {
      console.log(`\nvisited ${r.visited.length} screens`);
      if (r.failed?.length) {
        console.log(`${r.failed.length} failed:`);
        r.failed.forEach((f) => console.log(`  - ${f.label}: ${f.error}`));
      }
      if (r.blocked) {
        console.log(`BLOCKED on "${r.blocked.label}"`);
        console.log(`  ${r.blocked.reason}`);
      } else {
        console.log('walked to the end');
      }
    })
    .catch((e) => {
      console.error(String(e.stack || e.message || e));
      process.exit(1);
    });
}
