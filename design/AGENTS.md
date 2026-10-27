# Design pipeline

Edit these tools in this folder only. Never copy `scripts/` into an app repo.
Never hard-code `~/.claude/skills/design/scripts`.

Every path is a CLI argument or the app's `design.config.json`.

Brand tokens stay in `momentumlabs-company/design-system/`. Not in this folder.

The local Design MCP server is `scripts/mcp.mjs`. Its tool is `design_sync`.
It pulls, then generates, and it writes the files in the app repo. Register
it from that repo:

```
claude mcp add design -s project -- node node_modules/@momentumlabs/shared/design/scripts/mcp.mjs
```

The same server is the `momentum-design-mcp` bin (`npx --no-install momentum-design-mcp`).

This server is local because the write lands in the app's working tree.
Remote MomentumMCP (`hiring_*`) is a different server. It does not sync design.
