# momentumlabs-shared

One place for anything that must look and read the same on more than one Momentum Labs
site. Today that is the events page. Anything added later follows the same shape.

This repo is a library, not a website. Nothing here deploys.

## The rule

A consuming site never copies from here. It installs this package and renders the
component. If you find yourself editing a copy of one of these files inside
`admissionsos-marketing` or `momentumlabs-company`, the sharing has already broken.

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

Astro compiles `.astro` and `.ts` straight out of `node_modules`, so this package ships
source. There is nothing to compile and no `dist`.

## Self-contained styling

`events/events.css` carries its own colour tokens, fonts and layout classes. It has to,
because the two sites have different shells and neither one's stylesheet can be assumed.
The page renders identically inside either. Every class is prefixed `ev-` so it cannot
collide with a host site.

## Conventions

- `main` is **production** and is only reached via a `dev` → `main` PR.
- `dev` is the default branch — cut your branch off it and PR back into it.
