# momentumlabs-shared

One place for anything shared across Momentum Labs. Today that is the events
page, and the Claude Design pipeline (pull / push / gen) every app runs.

This repo is a library, not a website. Nothing here deploys.

## The rule

A consuming repo never copies from here. It installs this package and uses what
it exports. If you find yourself editing a copy of one of these files inside
another repo, or pointing a script at `~/.claude/skills/design/scripts`, the
sharing has already broken.

## How a site consumes it

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

## Design pipeline

Pull, push, and gen move work between Claude Design and a codebase. The scripts
are in this package, under `design/scripts/`. Install the package and call the
commands. Paths stay arguments, or a `design.config.json` in the consuming repo.
The tools do not know which app they are pointed at.

The company brand — colors, fonts, and component code — stays in
`momentumlabs-company/design-system/`. `momentum-design-tokens` only reads a
brand sheet you pass in and writes the sheet Claude Design imports. The colour
values in `events/events.css` are that page's own sheet, not the brand.

Same install as the events page:

```
npm install github:The-Momentum-Labs/momentumlabs-shared#main
```

One screen, arguments in the consuming repo's `package.json`:

```json
{
  "scripts": {
    "design:pull": "momentum-design-pull --project <uuid> --entry \"App.dc.html\" --out design/bundle",
    "design:push": "momentum-design-push --project <uuid> --dest photos --dir ./out",
    "design:gen": "momentum-design-gen --design design/bundle --entry \"App.dc.html\" --out src/generated --component DesignApp"
  }
}
```

The same three programs as files, when a caller needs a path:

```
node node_modules/@momentumlabs/shared/design/scripts/design-pull.mjs --project <uuid> --entry "App.dc.html" --out design/bundle
node node_modules/@momentumlabs/shared/design/scripts/design-push.mjs --project <uuid> --dest photos --dir ./out
node node_modules/@momentumlabs/shared/design/scripts/dc-gen.mjs --design design/bundle --entry "App.dc.html" --out src/generated --component DesignApp
```

Several screens, one manifest (the shape is in `design/scripts/manifest.mjs`):

```
momentum-design-pull --manifest design.config.json
momentum-design-gen --manifest design.config.json --check
```

`parse5`, `zod`, and the MCP SDK install with this package. A consumer does
not add them. Details, the other programs (merge guard, capture, tokens), and
the reference notes are in `design/README.md`.

## Self-contained styling

`events/events.css` carries its own colour tokens, fonts and layout classes. It has to,
because the two sites have different shells and neither one's stylesheet can be assumed.
The page renders identically inside either. Every class is prefixed `ev-` so it cannot
collide with a host site.

## Conventions

- `main` is **production** and is only reached via a `dev` → `main` PR.
- `dev` is the default branch — cut your branch off it and PR back into it.
