#!/usr/bin/env node
/**
 * mcp.mjs — the design pipeline as one tool call.
 *
 *   claude mcp add design -s project -- node node_modules/@momentumlabs/shared/design/scripts/mcp.mjs
 *   claude mcp add design -s project -- npx --no-install momentum-design-mcp
 *
 * design_sync runs what `npm run design` runs in a repo: design-pull.mjs then
 * dc-gen.mjs, both with --manifest design.config.json, for one screen or all.
 * It only calls the scripts beside it, so the pipeline stays in one place,
 * merge guard included (merge-guard.mjs): a file changed in the repo since the
 * last sync stops the run unless it is named in `accept`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = 'design.config.json';

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `$ ${script} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim() };
}

const server = new McpServer({ name: 'design', version: '1.0.0' });

server.registerTool(
  'design_sync',
  {
    title: 'Sync a screen from Claude Design',
    description:
      'Pull the latest design for a screen from Claude Design into the repo, then regenerate its code. ' +
      'Screens are the "name" entries in the repo\'s design.config.json (e.g. Sales). Omit screen to sync every screen. ' +
      'Every write goes through the merge guard: if a design file or a generated file was changed in the repo since the last sync, ' +
      'nothing is written and the result lists those files. Re-run with them in accept only when the Claude Design version should win. ' +
      'Does not push anything back to Claude Design.',
    inputSchema: {
      screen: z.string().optional().describe('Screen name from design.config.json, e.g. "Sales". Omit for all screens.'),
      accept: z.array(z.string()).optional().describe('Files the design may overwrite despite a repo edit, exactly as a blocked run names them.'),
      repo: z.string().optional().describe('Repo root holding design.config.json. Defaults to the session working directory.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ screen, accept, repo }) => {
    const cwd = resolve(repo ?? process.cwd());
    const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
    if (!existsSync(join(cwd, MANIFEST))) return fail(`No ${MANIFEST} in ${cwd}`);
    if (screen) {
      const names = JSON.parse(readFileSync(join(cwd, MANIFEST), 'utf8')).screens.map((s) => s.name);
      if (!names.includes(screen)) return fail(`Unknown screen "${screen}". ${MANIFEST} has: ${names.join(', ')}`);
    }
    const args = ['--manifest', MANIFEST, ...(screen ? ['--screen', screen] : []), ...(accept?.length ? ['--accept', accept.join(',')] : [])];
    const pull = run('design-pull.mjs', args, cwd);
    if (!pull.ok) return fail(pull.out);
    const gen = run('dc-gen.mjs', args, cwd);
    const text = `${pull.out}\n\n${gen.out}`;
    return gen.ok ? { content: [{ type: 'text', text }] } : fail(text);
  },
);

await server.connect(new StdioServerTransport());
