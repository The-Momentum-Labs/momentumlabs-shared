# momentumlabs-shared

One place for anything shared across Momentum Labs. Today that is the Claude
Design pipeline every app runs, and the events page.

This repo is a library, not a website. Nothing here deploys.

## Claude Design pipeline

Every Momentum repo installs this package and calls the bins. Once this is
merged to `dev`:

```
npm install github:The-Momentum-Labs/momentumlabs-shared#dev
```

Brand tokens stay in `momentumlabs-company/design-system/`. Not here.

`parse5`, `zod`, and the MCP SDK install with this package. A consumer does
not add them. Paths are arguments, or a `design.config.json` in the app.
Nothing in the tools is hard-coded to one repo or to a home directory.

| Bin | Runs |
|---|---|
| `momentum-design-pull` | Fetch a Claude Design project onto disk |
| `momentum-design-gen` | Regenerate React or Astro from the pulled files |
| `momentum-design-push` | Upload local files into a Claude Design project |
| `momentum-design-tokens` | Write Claude Design's token sheet from a brand stylesheet you pass in |
| `momentum-design-mcp` | Local MCP server. One tool, `design_sync` |

Edit the pipeline in this repo only. Do not copy the scripts into an app.
Folder layout, the other programs, and the reference notes are in
[`design/README.md`](design/README.md).

### React (manifest)

Several screens, each its own Claude Design project. The app keeps one
`design.config.json` (the shape is in `design/scripts/manifest.mjs`). Each
screen sets `mode` to `view` or `class`.

```json
{
  "scripts": {
    "design:pull": "momentum-design-pull --manifest design.config.json",
    "design:gen": "momentum-design-gen --manifest design.config.json",
    "design:check": "momentum-design-gen --manifest design.config.json --check",
    "design:push": "momentum-design-push --project <uuid> --dest <folder> --dir <local-dir> --plan-token <token>"
  }
}
```

`design:check` is for screens with `"mode": "view"`. It writes nothing and
exits 1 when a generated file is stale or missing. `--screen <Name>` limits
pull, gen, or check to one screen.

### Astro (flags)

One site. The arguments live on the command. `--config` is the app's route
and asset map. `--public` is that app's `public/` directory.

```json
{
  "scripts": {
    "design:pull": "momentum-design-pull --project <uuid> --entry index.html --out design/site",
    "design:gen": "momentum-design-gen --design design/site --entry index.html --out src/pages --config design.routes.json --public public",
    "design:push": "momentum-design-push --project <uuid> --dest <folder> --dir <local-dir> --plan-token <token>",
    "design:tokens": "momentum-design-tokens --css <design-system>/brand/index.css --tailwind <design-system>/brand/tailwind.config.ts --out styles.css",
    "design:tokens:check": "momentum-design-tokens --css <design-system>/brand/index.css --tailwind <design-system>/brand/tailwind.config.ts --out styles.css --check"
  }
}
```

`<design-system>` is `momentumlabs-company/design-system`, outside this
package. Astro gen has no `--check` flag. The merge guard inside gen refuses
to overwrite a page that changed in the repo since the last run.
`design:tokens:check` writes nothing and exits 1 when the token sheet is stale.

The same programs as files, when a caller needs a path:

```
node node_modules/@momentumlabs/shared/design/scripts/design-pull.mjs
node node_modules/@momentumlabs/shared/design/scripts/dc-gen.mjs
node node_modules/@momentumlabs/shared/design/scripts/design-push.mjs
node node_modules/@momentumlabs/shared/design/scripts/ds-tokens.mjs
node node_modules/@momentumlabs/shared/design/scripts/mcp.mjs
```

### Local Design MCP

`design_sync` is a local tool call. It writes files in the app repo, so the
server runs on the machine that has that repo. From the app, after the install
above:

```
claude mcp add design -s project -- node node_modules/@momentumlabs/shared/design/scripts/mcp.mjs
```

That file is the `momentum-design-mcp` bin. The same server, without a path:

```
claude mcp add design -s project -- npx --no-install momentum-design-mcp
```

The tool is `design_sync`. It reads `design.config.json`, pulls, then
generates. The merge guard stops the run when a design file or a generated
file changed in the repo since the last sync, and nothing is written.

| Argument | Required | Meaning |
|---|---|---|
| `screen` | no | One screen `name` from `design.config.json`. Omit to sync every screen. |
| `accept` | no | Files the design may overwrite, exactly as a blocked run names them. |
| `repo` | no | Repo root that holds `design.config.json`. Defaults to the working directory. |

`design_sync` does not push anything back to Claude Design.

This server is not MomentumMCP. The remote MomentumMCP tools (`hiring_*`)
talk to Momentum's hiring product. Design sync stays local because it writes
files in the app repo.

## The rule

A consuming repo never copies from here. It installs this package and uses what
it exports. If you find yourself editing a copy of one of these files inside
another repo, or pointing a script at `~/.claude/skills/design/scripts`, the
sharing has already broken.

## How a site consumes the events page

The events page is already on `main`. The design pipeline above is on `dev`
until a `dev` → `main` promotion.

```
npm install github:The-Momentum-Labs/momentumlabs-shared#main
```

```astro
---
import EventsPage from '@momentumlabs/shared/events/EventsPage.astro';
import { eventsJsonLd } from '@momentumlabs/shared/events/jsonLd.ts';
import SiteBase from '../layouts/SiteBase.astro';

const jsonLd = eventsJsonLd({
  siteUrl: 'https://momentumlabs.ai',
  orgName: 'Momentum Labs',
  path: '/events/',
});
---
<SiteBase title="Events" path="/events/" jsonLd={jsonLd}>
  <EventsPage />
</SiteBase>
```

Pass `product="admissionsos"` to both `EventsPage` and `eventsJsonLd` to narrow the list
to that product's events. Pass nothing and every Momentum Labs event shows.

## Adding or moving an event

`events/events.ts` is the only file to touch. Tag the event with the products it belongs
to. Both sites pick it up on their next build.

## No build step

Astro compiles `.astro` and `.ts` straight out of `node_modules`, and Node runs
the design `.mjs` files the same way, so this package ships source. There is
nothing to compile and no `dist`.

## Self-contained styling

`events/events.css` carries its own colour tokens, fonts and layout classes. It has to,
because the two sites have different shells and neither one's stylesheet can be assumed.
The page renders identically inside either. Every class is prefixed `ev-` so it cannot
collide with a host site. Those values are the events page's own sheet. The company
brand stays in `momentumlabs-company/design-system/`.

## Conventions

- `main` is **production** and is only reached via a `dev` → `main` PR.
- `dev` is the default branch — cut your branch off it and PR back into it.
