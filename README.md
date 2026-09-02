# momentumlabs-shared

Managed by Momentum Labs.

## Conventions

- `main` is **production** and is only reached via a `dev` → `main` PR.
- `dev` is the default branch — cut your branch off it and PR back into it.
- `main` deploys to **Vercel**; name a repo `-backend` (backend, lib,
  worker, scripts — anything that isn't a deployable website) to skip that.
- **This repo:** a Vercel production project is linked, deploying `main`.
