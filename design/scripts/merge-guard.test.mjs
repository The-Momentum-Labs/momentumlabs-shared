/**
 * Tests for the shared merge guard.
 *
 * Run: node --test design/scripts/merge-guard.test.mjs
 *
 * planWrites' text cases are proven in dc-gen-astro.test.mjs, which still
 * imports it through the astro driver. These cover what the other paths need
 * on top: binary files (class mode copies images into deps/), files the new
 * output no longer has (class mode used to rmSync them), applying a plan, and
 * the one error message every path throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planWrites, sha256, applyPlan, conflictError, guardedWrite } from './merge-guard.mjs';

const H = (s) => sha256(s);

test('identical binary content is unchanged, not a conflict', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const r = planWrites({ writes: [{ path: 'deps/a.png', body: png, current: Buffer.from(png) }], base: {} });
  assert.deepEqual(r.unchanged, ['deps/a.png']);
  assert.deepEqual(r.conflicts, []);
});

test('a changed binary with no fingerprint is a conflict', () => {
  const r = planWrites({ writes: [{ path: 'deps/a.png', body: Buffer.from([1]), current: Buffer.from([2]) }], base: {} });
  assert.deepEqual(r.conflicts.map((c) => c.path), ['deps/a.png']);
});

test('a file the new output drops is removed when untouched since the last run', () => {
  const r = planWrites({ writes: [], removes: [{ path: 'Old.tsx', current: 'OLD' }], base: { 'Old.tsx': H('OLD') } });
  assert.deepEqual(r.toRemove.map((x) => x.path), ['Old.tsx']);
  assert.deepEqual(r.conflicts, []);
});

test('a dropped file that was hand edited is a conflict, and blocks everything', () => {
  const r = planWrites({
    writes: [{ path: 'A.tsx', body: 'NEW', current: null }],
    removes: [{ path: 'Old.tsx', current: 'HAND' }],
    base: { 'Old.tsx': H('OLD') },
  });
  assert.deepEqual(r.conflicts.map((c) => c.path), ['Old.tsx']);
  assert.deepEqual(r.toWrite, []);
  assert.deepEqual(r.toRemove, []);
});

test('a dropped file with no fingerprint is a conflict unless accepted', () => {
  const r1 = planWrites({ writes: [], removes: [{ path: 'Mine.tsx', current: 'X' }], base: {} });
  assert.deepEqual(r1.conflicts.map((c) => c.path), ['Mine.tsx']);
  const r2 = planWrites({ writes: [], removes: [{ path: 'Mine.tsx', current: 'X' }], base: {}, accept: ['Mine.tsx'] });
  assert.deepEqual(r2.toRemove.map((x) => x.path), ['Mine.tsx']);
});

test('conflictError names every file and the exact --accept line', () => {
  const r = planWrites({
    writes: [{ path: 'a.tsx', body: 'NEW', current: 'HAND' }, { path: 'b.tsx', body: 'B', current: null }],
    base: { 'a.tsx': H('OLD') },
  });
  const e = conflictError(r);
  assert.match(e.message, /1 file\(s\) were changed by hand/);
  assert.match(e.message, /Nothing was written, not even the 1 clean file\(s\)/);
  assert.match(e.message, /--accept a\.tsx/);
});

test('applyPlan writes and removes exactly what the plan says', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  writeFileSync(join(dir, 'gone.txt'), 'x');
  applyPlan({
    toWrite: [{ path: 'sub/new.txt', dest: join(dir, 'sub/new.txt'), body: 'hi' }],
    toRemove: [{ path: 'gone.txt', dest: join(dir, 'gone.txt') }],
  });
  assert.equal(readFileSync(join(dir, 'sub/new.txt'), 'utf8'), 'hi');
  assert.equal(existsSync(join(dir, 'gone.txt')), false);
});

test('guardedWrite: first run writes new files and returns their fingerprints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  const fp = guardedWrite({ dir, files: [['a.txt', 'A']], base: {} });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A');
  assert.deepEqual(fp, { 'a.txt': H('A') });
});

test('guardedWrite: a hand edit throws and leaves every file as it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  const base = guardedWrite({ dir, files: [['a.txt', 'A'], ['b.txt', 'B']], base: {} });
  writeFileSync(join(dir, 'a.txt'), 'HAND');
  assert.throws(() => guardedWrite({ dir, files: [['a.txt', 'A2'], ['b.txt', 'B2']], base }), /--accept a\.txt/);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'HAND');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'B');
});

test('guardedWrite: accept lets the design win for that file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  const base = guardedWrite({ dir, files: [['a.txt', 'A']], base: {} });
  writeFileSync(join(dir, 'a.txt'), 'HAND');
  const fp = guardedWrite({ dir, files: [['a.txt', 'A2']], base, accept: ['a.txt'] });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A2');
  assert.deepEqual(fp, { 'a.txt': H('A2') });
});

test('guardedWrite: removeOthers drops untouched leftovers and keeps nothing stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  mkdirSync(join(dir, 'deps'));
  const base = guardedWrite({ dir, files: [['a.txt', 'A'], ['deps/old.js', 'O']], base: {}, removeOthers: true });
  guardedWrite({ dir, files: [['a.txt', 'A']], base, removeOthers: true });
  assert.equal(existsSync(join(dir, 'deps/old.js')), false);
});
