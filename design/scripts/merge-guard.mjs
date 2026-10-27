/**
 * merge-guard.mjs — the three way check every write in this pipeline goes
 * through: the pull, the view generator, the class generator and the astro
 * driver.
 *
 *   base    sha256 recorded when the file was last written by the pipeline
 *   ours    the file on disk now
 *   theirs  what the design says the file should be
 *
 *   ours == theirs            nothing to do
 *   ours == base              untouched since the last run: write
 *   otherwise                 someone changed the file by hand and the design
 *                             does not carry that change: conflict
 *   base unknown              no proof it was not hand edited: conflict
 *
 * One conflict blocks every write, including the clean ones, so the tree is
 * never half old and half new. `accept` names files the caller has decided to
 * lose; those are written over anyway. There is no --force on purpose.
 *
 * On 2026-10-16 this check did not exist and design:gen replaced a hand-fixed
 * recruiting form with the broken one still sitting in Claude Design. On
 * 2026-10-20 the pull overwrote repo edits to Sales.dc.html the same way.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Text compares as text; anything binary compares by fingerprint. */
function same(a, b) {
  return typeof a === 'string' && typeof b === 'string' ? a === b : sha256(a) === sha256(b);
}

/**
 * @param {{writes: {path: string, body: string|Buffer, current: string|Buffer|null}[],
 *          removes?: {path: string, current: string|Buffer}[],
 *          base: Record<string,string>, accept?: string[]}} a
 */
export function planWrites({ writes, removes = [], base, accept = [] }) {
  const accepted = new Set(accept);
  const unchanged = [];
  const conflicts = [];
  const wanted = [];
  const dropping = [];
  for (const w of writes) {
    if (w.current === null || w.current === undefined) { wanted.push(w); continue; }
    if (same(w.current, w.body)) { unchanged.push(w.path); continue; }
    const recorded = base[w.path];
    if (recorded && sha256(w.current) === recorded) { wanted.push(w); continue; }
    if (accepted.has(w.path)) { wanted.push(w); continue; }
    conflicts.push({
      path: w.path,
      reason: recorded
        ? 'hand edited since the last run, and the design does not carry that edit'
        : 'no recorded fingerprint for this file, so a hand edit cannot be ruled out',
    });
  }
  for (const r of removes) {
    const recorded = base[r.path];
    if (recorded && sha256(r.current) === recorded) { dropping.push(r); continue; }
    if (accepted.has(r.path)) { dropping.push(r); continue; }
    conflicts.push({
      path: r.path,
      reason: recorded
        ? 'the design no longer has this file, and it was hand edited since the last run'
        : 'the design does not have this file and it has no recorded fingerprint, so it may be hand written',
    });
  }
  if (conflicts.length) return { toWrite: [], toRemove: [], blocked: wanted, unchanged, conflicts };
  return { toWrite: wanted, toRemove: dropping, blocked: [], unchanged, conflicts };
}

export function conflictError(plan) {
  const lines = plan.conflicts.map((c) => `  ${c.path}\n    ${c.reason}`);
  return new Error(
    `${plan.conflicts.length} file(s) were changed by hand since the last run and the design would overwrite them.\n` +
      `Nothing was written, not even the ${plan.blocked.length} clean file(s).\n` +
      lines.join('\n') +
      `\nEither put the change into Claude Design and pull again, or re-run with\n` +
      `  --accept ${plan.conflicts.map((c) => c.path).join(',')}\n` +
      `to let the design win for exactly those files.`,
  );
}

export function applyPlan(plan) {
  for (const w of plan.toWrite) {
    mkdirSync(dirname(w.dest), { recursive: true });
    writeFileSync(w.dest, w.body);
  }
  for (const r of plan.toRemove || []) rmSync(r.dest, { force: true });
}

/** Every file under dir, as dir-relative posix paths. */
export function walk(dir, root = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/**
 * Plan, check and write a set of files under `dir`, keyed by their
 * dir-relative path. Throws conflictError and writes nothing on a conflict.
 * With removeOthers, every other file under `dir` (except `keep`) is one the
 * design no longer has and is removed, under the same guard.
 * Returns the fingerprints to record as the next run's base.
 */
export function guardedWrite({ dir, files, base, accept = [], removeOthers = false, keep = [] }) {
  const read = (p, body) => {
    const dest = join(dir, p);
    if (!existsSync(dest)) return null;
    return typeof body === 'string' ? readFileSync(dest, 'utf8') : readFileSync(dest);
  };
  const writes = files.map(([path, body]) => ({ path, body, dest: join(dir, path), current: read(path, body) }));
  const ours = new Set(files.map(([p]) => p));
  const removes = removeOthers
    ? walk(dir).filter((p) => !ours.has(p) && !keep.includes(p)).map((p) => ({ path: p, dest: join(dir, p), current: readFileSync(join(dir, p)) }))
    : [];
  const plan = planWrites({ writes, removes, base, accept });
  if (plan.conflicts.length) throw conflictError(plan);
  applyPlan(plan);
  return Object.fromEntries(files.map(([p, body]) => [p, sha256(body)]));
}
