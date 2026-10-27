#!/usr/bin/env node
/**
 * design-push.mjs — upload local files into a Claude Design project.
 *
 * The mirror of design-pull.mjs. Same endpoint, same Keychain auth, opposite
 * direction.
 *
 *   design-push.mjs --project <uuid> --dest photos --files "a.webp,b.webp"
 *   design-push.mjs --project <uuid> --dest photos --dir ./out [--ext webp]
 *
 * Why a script instead of calling write_files from the conversation: the design
 * API takes file bytes as inline base64, and base64 of a few dozen images is
 * tens of megabytes. Going through a tool call would mean the assistant emitting
 * all of it as text. Here the bytes are read off disk and encoded in-process, so
 * the conversation only carries the result.
 *
 *   write_files contract, from the tool's own schema:
 *     files: [{ path, data, encoding: 'base64', if_match? }]
 *     if_match "0" asserts the path does not exist, so an accidental overwrite
 *     is a refusal rather than a silent replacement. --force drops it.
 *
 * One upload per request on purpose. The server caps request size, a batch that
 * trips it fails every file in it, and a per-file loop means a failure names the
 * file and the rest still land.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const ENDPOINT = 'https://api.anthropic.com/v1/design/mcp';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const PROTOCOL = '2025-06-18';

/**
 * The extensions this will upload. An allow-list, nothing more: every file goes
 * up base64 and the server reads the type off the path, so the values here are
 * only documentation. Text types are in the list because an astro-target design
 * project IS a folder of plain .html pages and their .css and .js, and that is
 * the shape dc-gen-astro reads.
 */
const MEDIA = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.md': 'text/markdown', '.json': 'application/json', '.txt': 'text/plain',
  '.ts': 'text/plain', '.tsx': 'text/plain', '.astro': 'text/plain',
};

function die(msg) {
  process.stderr.write(`design-push: ${msg}\n`);
  process.exit(1);
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  die(`${flag} is required`);
}
const has = (flag) => process.argv.includes(flag);

const PROJECT = arg('--project');
const DEST = arg('--dest', '').replace(/^\/+|\/+$/g, '');
const DIR = arg('--dir', '');
const FILES = arg('--files', '');
const EXT = arg('--ext', '');
const FORCE = has('--force');
/**
 * Writing needs consent. A script cannot prompt for it, so the token is minted
 * in the conversation with finalize_plan (scope:"project" covers every path for
 * ~4 hours) and handed in here. Without it the server answers 403
 * needs_project_grant, which looks like a scope problem and is not one.
 */
const PLAN_TOKEN = arg('--plan-token', '');
const DRY = has('--dry');

/* ---------- auth: identical to design-pull.mjs -------------------------- */

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
  const creds = JSON.parse(raw);
  const d = creds.designOauth;
  if (!d?.accessToken) {
    die('no designOauth in the Keychain entry. Use any Claude Design tool in Claude Code once to authorize.');
  }
  if (d.expiresAt && Date.now() > Number(d.expiresAt)) {
    const ago = Math.round((Date.now() - Number(d.expiresAt)) / 60000);
    die(`the design token expired ${ago} min ago. Use any Claude Design tool in Claude Code once, then re-run.`);
  }
  return d.accessToken;
}

/* ---------- transport --------------------------------------------------- */

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
  if (!res.ok) {
    // The body carries the actual reason. Without it a 403 is unactionable.
    return { httpError: `HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 400)}` };
  }
  const body = await res.json();
  if (body.error) return { rpcError: body.error.message || JSON.stringify(body.error) };
  return body.result;
}

async function callTool(token, name, args) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  if (r.httpError || r.rpcError) return { text: r.httpError || r.rpcError, isError: true };
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  return { text, isError: !!r.isError };
}

/* ---------- what to send ------------------------------------------------ */

let paths = [];
if (FILES) {
  paths = FILES.split(',').map((s) => s.trim()).filter(Boolean);
} else if (DIR) {
  paths = readdirSync(DIR)
    .filter((f) => !EXT || extname(f).toLowerCase() === `.${EXT.replace(/^\./, '')}`)
    .map((f) => join(DIR, f))
    .filter((p) => statSync(p).isFile())
    .sort();
} else {
  die('--files or --dir is required');
}
if (paths.length === 0) die('nothing to upload');

const total = paths.reduce((n, p) => n + statSync(p).size, 0);
console.log(`${paths.length} files, ${(total / 1024 / 1024).toFixed(1)}MB -> ${PROJECT}${DEST ? '/' + DEST : ''}`);

if (DRY) {
  for (const p of paths) console.log(`  ${(statSync(p).size / 1024).toFixed(0)}KB  ${DEST ? DEST + '/' : ''}${basename(p)}`);
  console.log('--dry: nothing sent.');
  process.exit(0);
}

/* ---------- send -------------------------------------------------------- */

const token = designToken();

/**
 * The server wants the MCP handshake before it will run a tool. Without it a
 * write comes back 403, which reads like a permissions problem and is not one.
 * design-pull.mjs does the same call for the same reason.
 */
const init = await rpc(token, 'initialize', {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: 'design-push', version: '1.0' },
});
if (init.httpError || init.rpcError) die(`initialize -> ${init.httpError || init.rpcError}`);

let ok = 0;
const failed = [];

for (const [i, p] of paths.entries()) {
  const ext = extname(p).toLowerCase();
  if (!MEDIA[ext]) {
    failed.push({ p, why: `unsupported extension ${ext}` });
    continue;
  }
  const dest = `${DEST ? DEST + '/' : ''}${basename(p)}`;
  const file = { path: dest, data: readFileSync(p).toString('base64'), encoding: 'base64' };
  // Refuse rather than clobber, unless told otherwise.
  if (!FORCE) file.if_match = '0';

  const callArgs = { project_id: PROJECT, files: [file] };
  if (PLAN_TOKEN) callArgs.plan_token = PLAN_TOKEN;
  const r = await callTool(token, 'write_files', callArgs);
  if (r.isError) {
    failed.push({ p, why: r.text.slice(0, 300) });
    console.log(`  [${i + 1}/${paths.length}] FAILED ${dest}`);
    continue;
  }
  ok += 1;
  console.log(`  [${i + 1}/${paths.length}] ${dest}`);
}

console.log(`\nuploaded ${ok} of ${paths.length}`);
if (failed.length) {
  console.log(`\nFAILED: ${failed.length}`);
  for (const f of failed) console.log(`  ${basename(f.p)}\n    ${f.why}`);
  process.exitCode = 1;
}
