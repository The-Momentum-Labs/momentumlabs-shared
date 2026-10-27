#!/usr/bin/env node
/**
 * design-pull.mjs
 *
 * Pull a Claude Design project's files onto disk, so a repo can regenerate
 * itself from the design whenever Nico ships a change.
 *
 * The Claude Design MCP server is plain HTTP JSON-RPC. Verified 2026-09-28:
 *   POST https://api.anthropic.com/v1/design/mcp
 *   Authorization: Bearer <designOauth.accessToken from the macOS Keychain>
 *   initialize -> 200, stateless, no MCP-Session-Id required.
 *
 * Auth comes from the Keychain at run time and is never written anywhere.
 *
 * Usage:
 *   design-pull.mjs --project <uuid> --entry "App.dc.html" --out <dir>
 *                   [--extra a,b,c] [--skip a,b] [--all] [--dry]
 *   design-pull.mjs --manifest design.config.json [--screen <Name>] [--dry]
 *                   one run per screen in the manifest, see manifest.mjs
 *
 * Default mode walks the DEPENDENCY CLOSURE of --entry: every script, link,
 * img and css url() it references, transitively. --all pulls every file in the
 * project instead, which for a working project means its screenshots too.
 *
 * Known limit, by design, not worked around: read_file refuses binaries
 * ("is a binary file (stored base64); read_file only returns text content").
 * Those paths land in MISSING-BINARIES.txt so a missing image looks missing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { guardedWrite } from './merge-guard.mjs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, pullArgs, splitManifestArgs, runPerScreen } from './manifest.mjs';

const ENDPOINT = 'https://api.anthropic.com/v1/design/mcp';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const PROTOCOL = '2025-06-18';

/* ---------- cli ---------------------------------------------------------- */

function parseArgs(argv) {
  const out = { extra: [], skip: [], accept: [], all: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--entry') out.entry = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--extra') out.extra = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    // Paths known to be unreachable through this API, so a permanent condition
    // does not report itself as a failure on every run and break a `pull && gen`
    // chain. Every skip is listed in the manifest with its reason.
    else if (a === '--skip') out.skip = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    // Pulled files that may overwrite a repo edit (the merge guard's escape hatch).
    else if (a === '--accept') out.accept = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--all') out.all = true;
    else if (a === '--dry') out.dry = true;
    else die(`unknown argument: ${a}`);
  }
  if (!out.project) die('--project <uuid> is required');
  if (!out.out) die('--out <dir> is required');
  if (!out.entry && !out.all) die('--entry <path> is required unless --all');
  return out;
}

function die(msg) {
  process.stderr.write(`design-pull: ${msg}\n`);
  process.exit(1);
}

/* ---------- auth --------------------------------------------------------- */

/**
 * The design scopes live under their own key, separate from the main Claude
 * Code login. Read it fresh every run; an expired token is a hard stop, not a
 * thing to paper over, because a stale pull is worse than no pull.
 */
function designToken() {
  let raw;
  try {
    raw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    die(`no Keychain entry "${KEYCHAIN_SERVICE}". Sign in to Claude Code first.`);
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    die(`Keychain entry "${KEYCHAIN_SERVICE}" is not JSON.`);
  }
  const d = creds.designOauth;
  if (!d?.accessToken) {
    die('no designOauth in the Keychain entry. Use any Claude Design tool in Claude Code once to authorize.');
  }
  if (d.expiresAt && Date.now() > Number(d.expiresAt)) {
    const ago = Math.round((Date.now() - Number(d.expiresAt)) / 60000);
    die(
      `the design token expired ${ago} min ago. Use any Claude Design tool in Claude Code once to refresh it, then re-run.`
    );
  }
  return d.accessToken;
}

/* ---------- transport ---------------------------------------------------- */

let rpcId = 0;

async function rpc(token, method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (res.status === 401) {
    die('401 from the design API. Use any Claude Design tool in Claude Code once to refresh the token, then re-run.');
  }
  if (!res.ok) die(`${method} -> HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.error) die(`${method} -> ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

/** tools/call, flattened to the text payload. Returns {text, isError}. */
async function callTool(token, name, args) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const text = (r.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  return { text, isError: !!r.isError };
}

/* ---------- response unwrapping ----------------------------------------- */

const WRAP_OPEN = /^<untrusted-project-content\s([^>]*)>\n/;
const WRAP_CLOSE = '\n</untrusted-project-content>';

/**
 * When a read hits the 256 KiB cap the server appends its own status line
 * INSIDE the body, separated by one newline, e.g.
 *
 *   …[+667900 bytes truncated at read_file's 256 KiB cap — the body ends at a
 *    complete line; continue with offset=2348]
 *
 * That is a message about the response, not bytes of the file. Left in place it
 * welds one junk line into the middle of every stitched file. Matched on the
 * raw body before entity decoding, so decoding cannot reshape it.
 */
const CAP_NOTICE = /\n…\[\+\d+ bytes truncated at read_file[\s\S]*\]$/;

/**
 * read_file wraps the body in <untrusted-project-content> and escapes & < >
 * so the body cannot close the tag. Undo both.
 *
 * Decode order matters: &lt; and &gt; first, &amp; LAST. The encoder turned
 * a real "&amp;" in the file into "&amp;amp;", and decoding &amp; first would
 * collapse that to "&" and lose a character.
 */
export function unwrap(text, path) {
  const open = text.match(WRAP_OPEN);
  if (!open) die(`unexpected read_file shape for ${path}:\n${text.slice(0, 200)}`);
  const attrs = {};
  for (const m of open[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[m[1]] = m[2];

  const rest = text.slice(open[0].length);
  const end = rest.lastIndexOf(WRAP_CLOSE);
  if (end === -1) die(`unterminated read_file wrapper for ${path}`);

  const raw = rest.slice(0, end);
  const truncated = CAP_NOTICE.test(raw);
  const body = raw
    .replace(CAP_NOTICE, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const span = /^(\d+)-(\d+)$/.exec(attrs.lines || '');
  return {
    body,
    truncated,
    etag: attrs.etag,
    from: span ? Number(span[1]) : 1,
    to: span ? Number(span[2]) : null,
    total: attrs.total_lines ? Number(attrs.total_lines) : null,
    truncatedLine: attrs.truncated_line || null,
  };
}

/* ---------- reads -------------------------------------------------------- */

/**
 * read_file caps at 256 KiB, so a big file arrives in windows. Loop on the
 * wrapper's own line accounting rather than guessing a chunk size, and verify
 * the stitched line count against total_lines so a short read is an error
 * instead of a silently truncated file.
 */
async function readWholeFile(token, project, path) {
  const lines = [];
  let offset = 1;
  let etag = null;
  let total = null;

  for (;;) {
    const args = { project_id: project, path };
    if (offset > 1) args.offset = offset;
    const { text, isError } = await callTool(token, 'read_file', args);

    if (isError) {
      if (/is a binary file/.test(text)) return { binary: true };
      return { error: text.trim() };
    }

    const w = unwrap(text, path);

    // Nico edits these files live in Claude Design. If the etag moves between
    // windows, the halves came from different versions and stitching them makes
    // a file that never existed. Fail rather than hand over a chimera.
    if (etag !== null && w.etag !== etag) {
      return { error: `changed while being read (etag ${etag} -> ${w.etag}); re-run` };
    }
    etag = w.etag;
    total = w.total;

    if (w.truncatedLine) {
      return { error: `line ${w.truncatedLine} alone exceeds the 256 KiB read cap; cannot pull intact` };
    }
    if (w.truncated && w.total != null && w.to != null && w.to >= w.total) {
      return { error: `server reported truncation at line ${w.to} of ${w.total}, which cannot both be true` };
    }

    const chunk = w.body.split('\n');
    const hadTrailingBlank = chunk.length > 0 && chunk[chunk.length - 1] === '';
    if (hadTrailingBlank) chunk.pop();
    lines.push(...chunk);

    if (process.env.DESIGN_PULL_DEBUG) {
      const declared = w.to != null ? w.to - w.from + 1 : null;
      process.stderr.write(
        `    [win] lines=${w.from}-${w.to} total=${w.total} etag=${w.etag} ` +
          `declared=${declared} got=${chunk.length} trailingBlank=${hadTrailingBlank} ` +
          `running=${lines.length}\n`
      );
    }

    if (total == null || w.to == null || w.to >= total) break;
    if (w.to < offset) return { error: `read stalled at line ${w.to}` };
    offset = w.to + 1;
  }

  if (total != null && lines.length !== total) {
    return { error: `stitched ${lines.length} lines but the server reported ${total}` };
  }
  return { content: lines.join('\n') + '\n', etag, lines: lines.length };
}

async function listFiles(token, project) {
  const { text, isError } = await callTool(token, 'list_files', { project_id: project, depth: -1 });
  if (isError) die(`list_files failed: ${text}`);
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    die(`list_files did not return JSON:\n${text.slice(0, 200)}`);
  }
  return rows.filter((r) => r.type === 'file');
}

/* ---------- dependency closure ------------------------------------------ */

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mov|woff2?|ttf|otf|eot|pdf|zip)$/i;
const RECURSE_EXT = /\.(html|css)$/i;

/** Every path an html/css file points at. Deliberately broad and deduped. */
export function references(source) {
  const out = new Set();

  /**
   * <dc-import name="TextEntry"> pulls in a sibling component authored as its
   * own file. It is a dependency with no src attribute, so scanning only
   * src/href/url() silently misses it and the component renders as nothing.
   * Component names may contain spaces ("College List"), so these bypass the
   * path-shaped filter below.
   */
  for (const m of source.matchAll(/<dc-import[^>]*\sname\s*=\s*"([^"]+)"/gi)) {
    out.add(`${m[1]}.dc.html`);
  }
  // <x-import ... from="./image-slot.js"> names its module the same way.
  for (const m of source.matchAll(/<x-import[^>]*\sfrom\s*=\s*"([^"]+)"/gi)) {
    const p = m[1].replace(/^\.\//, '');
    if (p && !/^(https?:|\/)/i.test(p)) out.add(posix.normalize(p));
  }

  const add = (raw) => {
    if (!raw) return;
    let p = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!p || /^(https?:|data:|mailto:|tel:|blob:|#|\/\/)/i.test(p)) return;
    p = p.replace(/[?#].*$/, '').replace(/^\.\//, '');
    if (!p || p.startsWith('/')) return;
    // The entry .dc.html carries the whole logic class inline, and that JS
    // builds urls by concatenation ('url("' + x.icon + '")'). Those fragments
    // are not paths. Anything holding a quote, a plus, whitespace or template
    // syntax came from code, not from a reference.
    if (/["'`+$(){}]|\s/.test(p)) return;
    out.add(posix.normalize(p));
  };
  for (const m of source.matchAll(/<script[^>]*\ssrc\s*=\s*("[^"]*"|'[^']*')/gi)) add(m[1]);
  for (const m of source.matchAll(/<link[^>]*\shref\s*=\s*("[^"]*"|'[^']*')/gi)) add(m[1]);
  for (const m of source.matchAll(/<img[^>]*\ssrc\s*=\s*("[^"]*"|'[^']*')/gi)) add(m[1]);
  for (const m of source.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) add(m[1]);
  for (const m of source.matchAll(/@import\s+(?:url\()?\s*("[^"]*"|'[^']*')/gi)) add(m[1]);
  return [...out];
}

/* ---------- the entry must exist --------------------------------------- */

/**
 * A pull whose entry is not in the project is a dead run, and it must stop
 * before anything is fetched or written. On 2026-10-14 the entry had been
 * renamed in Claude Design; this printed a "missing:" line, exited 0, and
 * dc-gen rebuilt React from a three-week-old copy left on disk. Silence there
 * costs weeks of design. Throws rather than exits so it is testable.
 */
export function assertEntryPresent(entry, knownPaths) {
  if (!entry) return;
  const known = [...knownPaths];
  if (known.includes(entry)) return;
  // Only top-level .dc.html files are plausible entries. A project can hold
  // hundreds of per-screen components in subfolders and listing them buries
  // the answer.
  const designFiles = known.filter((p) => p.endsWith('.dc.html') && !p.includes('/')).sort();
  const nested = known.filter((p) => p.endsWith('.dc.html') && p.includes('/')).length;
  const lines = [
    `entry "${entry}" is not in this project. Nothing was pulled.`,
    'It was most likely renamed in Claude Design. Update --entry (and dc-gen\'s',
    '--entry) to the new name.',
  ];
  lines.push(
    designFiles.length
      ? `\ndesign files at the top level of the project:\n${designFiles.map((p) => `  ${p}`).join('\n')}` +
          (nested ? `\n  (plus ${nested} more in subfolders)` : '')
      : '\nthis project holds no .dc.html files at all.'
  );
  throw new Error(lines.join('\n'));
}

/* ---------- main --------------------------------------------------------- */

/**
 * Write the pulled files through the merge guard. The base is the sha256 each
 * file had when it was last pulled, recorded in MANIFEST.json. A design file
 * edited in the repo since then is a conflict and nothing is written.
 */
export function writePulled({ out, pulled, accept = [] }) {
  const manifestPath = join(out, 'MANIFEST.json');
  const base = {};
  if (existsSync(manifestPath)) {
    for (const f of JSON.parse(readFileSync(manifestPath, 'utf8')).files || []) if (f.sha256) base[f.path] = f.sha256;
  }
  mkdirSync(out, { recursive: true });
  return guardedWrite({ dir: out, files: pulled, base, accept });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = designToken();

  await rpc(token, 'initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'design-pull', version: '1.0' },
  });

  const listing = await listFiles(token, args.project);
  const known = new Map(listing.map((f) => [f.path, f]));
  process.stdout.write(`project holds ${known.size} files\n`);

  try {
    assertEntryPresent(args.entry, known.keys());
  } catch (e) {
    die(e.message);
  }

  // Decide the wanted set.
  const wanted = [];
  const seen = new Set();
  const queue = [];
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    queue.push(p);
  };

  if (args.all) {
    for (const f of listing) push(f.path);
  } else {
    push(args.entry);
    for (const e of args.extra) push(e);
  }

  const written = [];
  const pulled = [];
  const binaries = [];
  const failed = [];
  const dangling = [];
  const skippedOnPurpose = [];

  while (queue.length) {
    const path = queue.shift();

    if (args.skip.includes(path)) {
      skippedOnPurpose.push(path);
      continue;
    }
    if (!known.has(path)) {
      dangling.push(path);
      continue;
    }
    if (BINARY_EXT.test(path)) {
      binaries.push({ path, size: known.get(path).size });
      continue;
    }

    const r = await readWholeFile(token, args.project, path);
    if (r.binary) {
      binaries.push({ path, size: known.get(path).size });
      continue;
    }
    if (r.error) {
      failed.push({ path, error: r.error });
      process.stderr.write(`  FAILED ${path}: ${r.error}\n`);
      continue;
    }

    written.push({ path, etag: r.etag, lines: r.lines, bytes: Buffer.byteLength(r.content) });
    process.stdout.write(`  ${path} (${r.lines} lines)\n`);

    pulled.push([path, r.content]);

    if (!args.all && RECURSE_EXT.test(path)) {
      const base = posix.dirname(path);
      for (const ref of references(r.content)) {
        // References resolve against the project root first, then the file's
        // own directory. The bundle writes both ("data/places.js" from the
        // root file, "tokens/index.css" from inside a css file).
        const asRoot = ref;
        const asRel = base === '.' ? ref : posix.normalize(posix.join(base, ref));
        if (known.has(asRoot)) push(asRoot);
        else if (known.has(asRel)) push(asRel);
        else push(asRoot);
      }
    }
    wanted.push(path);
  }

  if (args.dry) {
    process.stdout.write(`\ndry run: ${written.length} text files, ${binaries.length} binaries, nothing written\n`);
    return;
  }

  let fingerprints;
  try {
    fingerprints = writePulled({ out: args.out, pulled, accept: args.accept });
  } catch (e) {
    die(e.message);
  }
  for (const w of written) w.sha256 = fingerprints[w.path];

  const manifest = {
    project: args.project,
    entry: args.entry || null,
    mode: args.all ? 'all' : 'closure',
    pulledAt: new Date().toISOString(),
    files: written.sort((a, b) => a.path.localeCompare(b.path)),
    binariesSkipped: binaries.sort((a, b) => a.path.localeCompare(b.path)),
    failed,
    skippedOnPurpose: skippedOnPurpose.sort(),
    referencedButNotInProject: dangling.sort(),
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  if (binaries.length) {
    const lines = [
      'Binaries the design API will not hand over.',
      '',
      'read_file returns: "is a binary file (stored base64); read_file only',
      'returns text content". There is no text path to these bytes, so they are',
      'not pulled and nothing is substituted for them. Download them by hand',
      'from the project once; they rarely change.',
      '',
      `project: ${args.project}`,
      '',
      ...binaries.map((b) => `${b.path}\t${b.size} bytes`),
      '',
    ];
    writeFileSync(join(args.out, 'MISSING-BINARIES.txt'), lines.join('\n'));
  }

  process.stdout.write(
    `\npulled ${written.length} files into ${args.out}\n` +
      `  binaries skipped: ${binaries.length}\n` +
      `  skipped by --skip: ${skippedOnPurpose.length}\n` +
      `  read failures: ${failed.length}\n` +
      `  referenced but absent from the project: ${dangling.length}\n`
  );
  if (skippedOnPurpose.length) for (const s2 of skippedOnPurpose) process.stdout.write(`    skipped: ${s2}\n`);
  if (dangling.length) for (const d of dangling) process.stdout.write(`    missing: ${d}\n`);
  if (failed.length) process.exit(2);
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { manifest, only, rest } = splitManifestArgs(process.argv.slice(2));
  if (manifest) {
    let screens;
    try {
      screens = loadManifest(manifest, only);
    } catch (e) {
      die(e.message);
    }
    const self = fileURLToPath(import.meta.url);
    process.exit(runPerScreen(self, 'pulling', screens, (s) => pullArgs(s), rest));
  }
  main().catch((e) => die(e?.stack || String(e)));
}
