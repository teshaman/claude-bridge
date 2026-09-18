# Claude Bridge

A tiny Foundry VTT module plus a zero-dependency MCP server that lets Claude Code run
JavaScript in the GM's browser: read and write flags, call module APIs (Skill Tree,
Item Piles, DAE…), create script macros, and inspect anything Familiar cannot reach.

It follows the same design as the Quick Shop bridge: the module in the GM's browser
opens a WebSocket to `ws://localhost:30311`, where the MCP server on your PC listens.
Nothing is exposed to the network; the server binds to 127.0.0.1 only.

## Parts

| Path | What it is |
|---|---|
| `module.json`, `scripts/claude-bridge.mjs` | The Foundry module (upload this to Forge) |
| `mcp/server.mjs` | The MCP server Claude Code launches (stays on your PC) |

## Install on The Forge

1. Zip the module folder (`claude-bridge-v1.0.0.zip` next to this folder is ready to use).
2. On The Forge: **Setup → Modules → Import Wizard** (or "Install a module from a zip"), upload the zip.
3. In the world: **Manage Modules → enable Claude Bridge**.
4. **Configure Settings → Claude Bridge**: tick **Enable Claude Code bridge**. Port stays 30311.

## Register the MCP server with Claude Code (once)

```
claude mcp add -s user claude-bridge -- node "C:\Users\alexg\Documents\Foundry\Pillars of palor\Foundry Modules\claude-bridge\mcp\server.mjs"
```

Restart Claude Code. The `bridge_status` tool reports whether Foundry is connected.

## Using it from Codex (ChatGPT) as well

The MCP server is plain stdio, so the OpenAI Codex CLI can load it too. In `~/.codex/config.toml`:

```toml
[mcp_servers.claude-bridge]
enabled = true
command = "node"
args = ['C:\Users\alexg\Documents\Foundry\Pillars of palor\claude-bridge\mcp\server.mjs']
```

Only one assistant can hold the bridge at a time: the server binds port 30311 and the Foundry module connects to one port. If Claude Code and Codex are both open, the second server reports the port as busy and its tools explain that; close one of them or give it a different port (`CLAUDE_BRIDGE_PORT` plus the module's port setting). Since 1.0.2 the waiting server retries the port every few seconds and takes it over as soon as the other one exits, so a Claude Code restart no longer leaves the bridge dead for the session.

## Optional shared token

Start the server with `CLAUDE_BRIDGE_TOKEN=<secret>` (add `-e CLAUDE_BRIDGE_TOKEN=<secret>` to the
`claude mcp add` command) and enter the same value in the module's **Shared token** setting.

## Tools

- `bridge_status` — connection check and world summary
- `run_script` — run a JavaScript function body in the GM client; `return` a value
- `get_document` / `update_document` / `create_document` / `delete_document` — any document by UUID, flags included
- `create_macro` / `update_macro` — script or chat macros

## Revoking access

Untick the bridge setting or disable the module. Claude can only reach Foundry while a GM browser
on this machine is connected and the setting is on.

## Compatibility

- Foundry VTT 13–14 (verified 14.365)
- Node 18+ for the MCP server (no npm install needed)
