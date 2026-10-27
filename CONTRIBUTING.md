# Contributing

Shared code is edited in this repo. A consuming app installs
`@momentumlabs/shared`. It does not keep its own copy.

## Design pipeline

The Claude Design tools live in `design/`. Edit them here. Do not copy
`design/scripts/` into an app repo, and do not point an app at
`~/.claude/skills/design/scripts`.

Paths the tools read are arguments, or that app's `design.config.json`.

Brand tokens stay in `momentumlabs-company/design-system/`. Do not add them
to this repo.

The local Design MCP server is `design/scripts/mcp.mjs`. Its tool is
`design_sync`. It writes files in the app repo. Register it from that repo
with `claude mcp add design -s project`. The remote MomentumMCP server
(`hiring_*`) is a different server and does not sync design.

How to install and call the bins is in the README.

## Branches

`dev` is the working branch. Open pull requests against `dev`. `main` is
production and only updates from a `dev` → `main` pull request.

## Tests

```
npm install
npm test
```
