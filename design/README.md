# Design pipeline

The pull / push / gen tools every Momentum Labs repo runs. They live in this
folder. A repo installs `@momentumlabs/shared` and calls the bins. It does not
copy these files, and it does not hard-code a home-directory path.

Every path is a CLI argument, or one `design.config.json` when a repo has
several screens. The tools do not point at a particular app.

Brand tokens stay in `momentumlabs-company/design-system/`. Not here.
`momentum-design-tokens` only reads a stylesheet you pass in.

Copy-paste `package.json` scripts for React (manifest) and Astro (flags) are
in the repo [README](../README.md). Once this is on `dev`:

```
npm install github:The-Momentum-Labs/momentumlabs-shared#dev
```

## Folder layout

```
design/
  AGENTS.md     rule for anyone editing this folder
  README.md     this file
  reference/    what is known about Claude Design. No brand values.
    claude-design.md
    layers.md
  scripts/      the programs, and a test file beside each one
```

`scripts/` is the pipeline. `reference/` is the notes. Tests run from the repo
root with `npm test`. There is no build step.

## How a consumer calls the tools

Paths below are arguments. Replace them with the app's own files. Do not point
any of these at `~/.claude/skills/design/scripts`.

Pull, one project:

```
momentum-design-pull --project <uuid> --entry "App.dc.html" --out design/bundle
```

Pull, several screens:

```
momentum-design-pull --manifest design.config.json
momentum-design-pull --manifest design.config.json --screen Sales
```

Generate:

```
momentum-design-gen --design design/bundle --entry "App.dc.html" --out src/generated --component DesignApp
momentum-design-gen --manifest design.config.json
momentum-design-gen --design design/site --entry index.html --out src/pages --config design.routes.json --public public
```

Check. View-mode screens and the token sheet have a dry run. Both write
nothing and exit 1 when the output is stale:

```
momentum-design-gen --manifest design.config.json --check
momentum-design-tokens --css <design-system>/brand/index.css --tailwind <design-system>/brand/tailwind.config.ts --out styles.css --check
```

`design:check` applies to manifest screens whose `mode` is `view`. Astro gen
and class mode do not take `--check`. Their merge guard runs on the real
write and refuses to overwrite a file the repo changed since the last run.

Push. `--plan-token` comes from Claude Design's `finalize_plan`:

```
momentum-design-push --project <uuid> --dest <folder> --dir <local-dir> --plan-token <token>
```

Tokens. The two inputs are brand files in `momentumlabs-company/design-system/`,
not files in this package:

```
momentum-design-tokens --css <design-system>/brand/index.css --tailwind <design-system>/brand/tailwind.config.ts --out styles.css
```

The same commands as files:

```
node node_modules/@momentumlabs/shared/design/scripts/design-pull.mjs
node node_modules/@momentumlabs/shared/design/scripts/dc-gen.mjs
node node_modules/@momentumlabs/shared/design/scripts/design-push.mjs
node node_modules/@momentumlabs/shared/design/scripts/ds-tokens.mjs
```

## Local Design MCP

This is the tool call. It is a local stdio server. `design_sync` pulls and
then generates, and it writes the files in the app repo, so Claude has to
launch it on that machine. Register it from the app, at project scope:

```
claude mcp add design -s project -- node node_modules/@momentumlabs/shared/design/scripts/mcp.mjs
```

The bin is the same program:

```
claude mcp add design -s project -- npx --no-install momentum-design-mcp
```

`design_sync` always uses `design.config.json` in the repo it is pointed at.
It runs `design-pull.mjs` and then `dc-gen.mjs`, both with `--manifest`. The
merge guard is included: a design file or a generated file that changed in
the repo since the last sync stops the run, and nothing is written.

| Argument | Required | Meaning |
|---|---|---|
| `screen` | no | One screen `name` from the manifest. Omit to sync every screen. |
| `accept` | no | List of files a blocked run printed. The design may overwrite those. |
| `repo` | no | Absolute or relative root that holds `design.config.json`. Defaults to the working directory. |

It does not push.

Remote MomentumMCP (`hiring_*` and the rest of that server) is a different
process, reached over the network, for Momentum's hiring product. It does not
see the app's working tree. Design sync stays this local server because the
write has to land in the app repo.

## Programs

| Program | Bin or path | What it does |
|---|---|---|
| `design-pull.mjs` | `momentum-design-pull` | Fetch a project's files. Default is the dependency closure of `--entry`. |
| `design-push.mjs` | `momentum-design-push` | Upload local files. Needs `--plan-token`. |
| `dc-gen.mjs` | `momentum-design-gen` | Detect react or astro, then convert. |
| `ds-tokens.mjs` | `momentum-design-tokens` | Token sheet from a brand stylesheet you pass in. |
| `mcp.mjs` | `momentum-design-mcp` | Local MCP. The tool is `design_sync`. |
| `auth.mjs` | `node …/design/scripts/auth.mjs` | Mint a Supabase session as a Playwright storageState. |
| `walk.mjs` | `node …/design/scripts/walk.mjs` | Walk an app's screens. Advance and dismiss are arguments. |
| `capture.mjs` | `node …/design/scripts/capture.mjs` | Write what the browser drew as `.dc.html`. |
| `merge-guard.mjs` | imported by the writers | Refuse to overwrite a file the repo changed since the last run. |
| `manifest.mjs` | imported by pull and gen | Read `design.config.json`. |
| `dc-detect.mjs` | imported by gen | Say which converter an entry file belongs to. |
| `dc-to-react.mjs` | library | `.dc.html` to React, logic class carried over. |
| `dc-to-view.mjs` | library | `.dc.html` to a React view over a bindings object. |
| `dc-to-astro.mjs` | library | A static html page to `.astro`. |
| `dc-gen-astro.mjs` | imported by gen | Discover pages, vendor stylesheets, write one `.astro` per page. |

`auth.mjs`, `walk.mjs`, and `capture.mjs` load Playwright from the consuming
repo (`@playwright/test` next to that repo's `package.json`). This package
does not depend on Playwright.

`dc-gen` reads the entry file and picks react or astro. `--target` only pins
that choice. A pin that disagrees with the file stops the run. For react,
`--mode class` (the default) or `--mode view` is the repo's choice. Class
mode rebuilds the whole `--out` folder. Point it only at a generated folder.

## Tests

From this repo, after `npm install`:

```
npm test
```

One file:

```
node --test design/scripts/design-pull.test.mjs
```

## Reference

`reference/layers.md` is the four-layer vocabulary. `reference/claude-design.md`
is the Claude Design object model and what is verified versus unknown. Read
those before inventing a design rule. This folder does not add new ones.
