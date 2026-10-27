# Design pipeline

The pull / push / gen tools every Momentum Labs repo runs. They used to live
only on one laptop at `~/.claude/skills/design/scripts`. They live here now.
A repo installs `@momentumlabs/shared` and calls the commands. It does not
copy these files and it does not hard-code a home-directory path.

The tools are repo-agnostic. Every path is a CLI argument, or one
`design.config.json` when a repo has several screens. Nothing in here points
at BusinessOS, the company site, or any other app.

`parse5`, `zod`, and `@modelcontextprotocol/sdk` are dependencies of
`@momentumlabs/shared`. Installing this package installs them, so a consumer
does not add them itself. There is no build step. Node runs the `.mjs` files
as they are.

## Brand tokens are not in this package

Colors, fonts, and component code stay in `momentumlabs-company/design-system/`.
That folder is the source of truth. It is pushed from there into Claude
Design. Do not copy those values into this repo.

`momentum-design-tokens` (`design/scripts/ds-tokens.mjs`) only reads a brand
sheet you pass on the command line and writes the token sheet Claude Design
imports. The sheet is generated. The brand files are not.

```
momentum-design-tokens --css path/to/brand/index.css --tailwind path/to/brand/tailwind.config.ts --out styles.css
```

`--check` writes nothing and exits 1 when `--out` is stale.

## What a consuming repo runs

Install this package (the same install as the events page):

```
npm install github:The-Momentum-Labs/momentumlabs-shared#main
```

One design, arguments in `package.json`:

```json
{
  "scripts": {
    "design:pull": "momentum-design-pull --project <uuid> --entry \"App.dc.html\" --out design/bundle",
    "design:push": "momentum-design-push --project <uuid> --dest photos --dir ./out",
    "design:gen": "momentum-design-gen --design design/bundle --entry \"App.dc.html\" --out src/generated --component DesignApp"
  }
}
```

The same three programs as files, when a tool needs a path instead of a bin:

```
node node_modules/@momentumlabs/shared/design/scripts/design-pull.mjs --project <uuid> --entry "App.dc.html" --out design/bundle
node node_modules/@momentumlabs/shared/design/scripts/design-push.mjs --project <uuid> --dest photos --dir ./out
node node_modules/@momentumlabs/shared/design/scripts/dc-gen.mjs --design design/bundle --entry "App.dc.html" --out src/generated --component DesignApp
```

Several screens, recorded once in `design.config.json` (schema in
`design/scripts/manifest.mjs`):

```
momentum-design-pull --manifest design.config.json
momentum-design-gen --manifest design.config.json --check
```

`--screen <Name>` limits either command to one screen. Paths in the manifest
are relative to the repo you run from.

`dc-gen` reads the entry file and picks react or astro. `--target` only pins
that choice; a pin that disagrees with the file stops the run. For react,
`--mode class` (the default) or `--mode view` is the repo's choice. Class
mode rebuilds the whole `--out` folder. Point it only at a generated folder.

## The other programs

| Program | Bin or path | What it does |
|---|---|---|
| `design-pull.mjs` | `momentum-design-pull` | Fetch a project's files onto disk. Default is the dependency closure of `--entry`, not every screenshot. |
| `design-push.mjs` | `momentum-design-push` | Upload local files into a project. Needs `--plan-token` from Claude Design's `finalize_plan`. |
| `dc-gen.mjs` | `momentum-design-gen` | Detect the target, then run the react or astro converter. |
| `ds-tokens.mjs` | `momentum-design-tokens` | Render Claude Design's token sheet from a brand stylesheet you pass in. |
| `mcp.mjs` | `momentum-design-mcp` | One tool, `design_sync`, that pulls then generates for a manifest. |
| `auth.mjs` | `node …/design/scripts/auth.mjs` | Mint a Supabase session as a Playwright storageState. |
| `walk.mjs` | `node …/design/scripts/walk.mjs` | Walk an app's screens. The advance and dismiss buttons are arguments. |
| `capture.mjs` | `node …/design/scripts/capture.mjs` | Write what the browser drew into a project as `.dc.html`. |
| `merge-guard.mjs` | imported by the writers | Refuse to overwrite a file that changed in the repo since the last run. |
| `manifest.mjs` | imported by pull and gen | Read `design.config.json`. |
| `dc-detect.mjs` | imported by gen | Say which converter an entry file belongs to. |
| `dc-to-react.mjs` | library | `.dc.html` to React, logic class carried over. |
| `dc-to-view.mjs` | library | `.dc.html` to a React view over a bindings object. |
| `dc-to-astro.mjs` | library | A static html page to `.astro`. |
| `dc-gen-astro.mjs` | imported by gen | Discover pages, vendor stylesheets, write one `.astro` per page. |

`auth.mjs`, `walk.mjs`, and `capture.mjs` load Playwright from the consuming
repo (`@playwright/test` next to that repo's `package.json`). This package
does not depend on Playwright.

Register the MCP server from a repo that has installed this package:

```
claude mcp add design -s project -- node node_modules/@momentumlabs/shared/design/scripts/mcp.mjs
```

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
