/**
 * manifest.mjs — a repo's design.config.json, shared by design-pull.mjs and
 * dc-gen.mjs.
 *
 * A repo with one design (HSO's portal, the company site) records its arguments
 * in package.json and never needs this. A repo with several screens, each its
 * own Claude Design project, records them once here and both tools loop it:
 *
 *   {
 *     "screens": [
 *       {
 *         "name": "Sales",                       required. --name for view mode
 *         "project": "e7340402-…",               required. the Claude Design project
 *         "entry": "Sales.dc.html",              required. the entry file
 *         "designDir": "src/pages/sales/design", required. where the pull lands
 *         "outDir": "src/pages/sales",           required. where gen writes
 *         "mode": "view",                        required. class or view. No default:
 *                                                class mode wipes outDir on every run
 *         "screenLabel": "Sales",                view mode: data-screen-label, default name
 *         "header": true,                        view mode: also emit <Name>HeaderView
 *         "logic": true,                         view mode: also emit <Name>Logic.generated.js
 *                                                (the design's own logic class, for spaces the
 *                                                app runs as designed)
 *         "component": "DesignApp",              class mode: entry component name
 *         "extra": ["a.css"], "skip": ["b.png"]  pull: passed through as --extra / --skip
 *       }
 *     ]
 *   }
 *
 * Paths are repo-relative. Both tools take `--manifest <file> [--screen <Name>]`
 * and re-run themselves once per screen with that screen's flags, plus any
 * other flags given (--dry, --check). The first failing screen stops the run,
 * so a half-pulled set never reaches the transpiler.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// `mode` is required on purpose. Class mode rebuilds its whole outDir, so a
// manifest that forgot the mode must not fall into it: it wiped a folder once.
const REQUIRED = ['name', 'project', 'entry', 'designDir', 'outDir', 'mode'];

/** Reads and validates the manifest. `only` narrows it to one screen by name. */
export function loadManifest(path, only) {
  const file = resolve(process.cwd(), path);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read manifest ${path}: ${e.message}`);
  }
  const all = Array.isArray(config.screens) ? config.screens : [];
  if (!all.length) throw new Error(`${path} has no screens`);
  for (const s of all) {
    for (const k of REQUIRED) {
      if (!s[k]) throw new Error(`${path}: screen ${s.name ?? '?'} is missing "${k}"`);
    }
    if (s.mode !== 'class' && s.mode !== 'view') {
      throw new Error(`${path}: screen ${s.name} mode must be class or view, got ${s.mode}`);
    }
  }
  const screens = only ? all.filter((s) => s.name === only) : all;
  if (!screens.length) throw new Error(`no screen named ${only} in ${path}`);
  return screens;
}

/** The pull flags for one screen. */
export function pullArgs(s) {
  const a = ['--project', s.project, '--entry', s.entry, '--out', s.designDir];
  if (s.extra?.length) a.push('--extra', s.extra.join(','));
  if (s.skip?.length) a.push('--skip', s.skip.join(','));
  return a;
}

/** The gen flags for one screen. */
export function genArgs(s) {
  const a = ['--design', s.designDir, '--entry', s.entry, '--out', s.outDir, '--mode', s.mode];
  if (s.mode === 'view') {
    a.push('--name', s.name);
    if (s.screenLabel) a.push('--label', s.screenLabel);
    if (s.header) a.push('--header');
    if (s.logic) a.push('--logic');
  } else if (s.component) {
    a.push('--component', s.component);
  }
  return a;
}

/**
 * Pulls `--manifest <file>` and `--screen <Name>` out of argv. Returns
 * { manifest, only, rest }, where rest is every other flag, to pass through.
 */
export function splitManifestArgs(argv) {
  let manifest;
  let only;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') manifest = argv[++i];
    else if (argv[i] === '--screen') only = argv[++i];
    else rest.push(argv[i]);
  }
  return { manifest, only, rest };
}

/**
 * Re-runs `tool` once per screen, with argsFor(screen) plus `rest`. Stops on
 * the first failure and returns that exit code; 0 when every screen passed.
 */
export function runPerScreen(tool, label, screens, argsFor, rest) {
  for (const s of screens) {
    process.stdout.write(`[${s.name}] ${label}\n`);
    const r = spawnSync(process.execPath, [tool, ...argsFor(s), ...rest], { stdio: 'inherit' });
    if (r.status !== 0) {
      process.stderr.write(`[${s.name}] failed, stopping\n`);
      return r.status ?? 1;
    }
  }
  return 0;
}
