/**
 * Mint a real Supabase session and write it as a Playwright storageState file.
 *
 * Why this exists: the capture pipeline has to see pages the way a signed-in user
 * sees them, and no human should ever have to log in for it to run. Every app in
 * this stack authenticates through Supabase, so one adapter covers all of them.
 *
 * How it works: the admin API mints a magic link, we redeem its OTP for a real
 * session, then write that session into the cookie shape @supabase/ssr reads. That
 * path sidesteps the Turnstile captcha that guards password login, because no
 * password is ever submitted.
 *
 * Sessions are minted fresh on every run, so expiry is not a thing that can break.
 *
 * Usage:
 *   node auth.mjs --ref <project-ref> --email <account> --origin <https://site>
 *                 [--env <path/to/.env>] [--out <path>]
 *
 * Keys are read from the env file (SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_ANON_KEY)
 * or from the process environment. Never pass a key on the command line: it would
 * land in your shell history.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Supabase's ssr cookie chunker splits at this width. Match it exactly. */
const MAX_CHUNK = 3180;

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

/** Read a dotenv-style file into a plain object. Missing file is not an error. */
export function readEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      }),
  );
}

/**
 * Mint a session for `email` on the Supabase project `ref`.
 * Returns the raw session object Supabase handed back.
 */
export async function mintSession({ ref, email, serviceRoleKey, anonKey }) {
  const base = `https://${ref}.supabase.co`;

  const genRes = await fetch(`${base}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const gen = await genRes.json();
  if (!gen?.email_otp) {
    throw new Error(`generate_link failed for ${email} (HTTP ${genRes.status}): ${JSON.stringify(gen)}`);
  }

  const verRes = await fetch(`${base}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email, token: gen.email_otp }),
  });
  const ver = await verRes.json();
  if (!ver?.access_token) {
    throw new Error(`verify failed for ${email} (HTTP ${verRes.status}): ${JSON.stringify(ver)}`);
  }

  return {
    access_token: ver.access_token,
    token_type: ver.token_type,
    expires_in: ver.expires_in,
    expires_at: ver.expires_at,
    refresh_token: ver.refresh_token,
    user: ver.user,
  };
}

/**
 * Turn a session into the cookie set @supabase/ssr expects, scoped to `origin`.
 * Long values are split across numbered cookies the same way the client library
 * does, because the client reassembles them by that naming convention.
 */
export function sessionToCookies(session, ref, origin) {
  const name = `sb-${ref}-auth-token`;
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const { hostname } = new URL(origin);

  const shared = {
    domain: hostname,
    path: '/',
    expires: session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    httpOnly: false,
    secure: origin.startsWith('https'),
    sameSite: 'Lax',
  };

  if (value.length <= MAX_CHUNK) return [{ name, value, ...shared }];

  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${name}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      ...shared,
    });
  }
  return cookies;
}

/** Mint, format, and write a Playwright storageState file. Returns its path. */
export async function writeStorageState({ ref, email, origin, serviceRoleKey, anonKey, out }) {
  const session = await mintSession({ ref, email, serviceRoleKey, anonKey });
  const state = { cookies: sessionToCookies(session, ref, origin), origins: [] };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(state, null, 2));
  fs.chmodSync(out, 0o600);
  return { path: out, expiresAt: session.expires_at, userId: session.user?.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const missing = ['ref', 'email', 'origin'].filter((k) => !args[k]);
  if (missing.length) {
    console.error(`missing required arg(s): ${missing.map((m) => '--' + m).join(', ')}`);
    console.error('usage: node auth.mjs --ref <ref> --email <email> --origin <url> [--env <file>] [--out <file>]');
    process.exit(2);
  }

  const fileEnv = readEnvFile(args.env);
  const serviceRoleKey = fileEnv.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey =
    fileEnv.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || fileEnv.SUPABASE_ANON_KEY;

  if (!serviceRoleKey || !anonKey) {
    console.error('need SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_ANON_KEY, from --env or the environment');
    process.exit(2);
  }

  const out = args.out || `/tmp/design-capture/${args.ref}-${args.email.replace(/[^a-z0-9]/gi, '_')}.json`;

  writeStorageState({ ...args, serviceRoleKey, anonKey, out })
    .then((r) => {
      console.log(`wrote ${r.path}`);
      console.log(`user  ${r.userId}`);
      console.log(`until ${new Date(r.expiresAt * 1000).toISOString()}`);
    })
    .catch((e) => {
      console.error(String(e.message || e));
      process.exit(1);
    });
}
