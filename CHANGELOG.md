# claude-bridge — Changelog

All notable changes to this module. Newest version first.
Older packaged zips are kept in `backups/` and are never deleted.

## 1.0.2 — 2026-09-18
- MCP server: when the bridge port is busy (a previous Claude Code session still shutting down, or Codex), keep retrying every 3 s and bind as soon as it frees; before, one conflict at startup left the bridge dead for the whole session.
- bridge_status hint explains that the server retries on its own.
- Server version string now follows the module version.

## 1.0.1 — 2026-09-14
- Clear message when the bridge port is already held by another assistant (Claude Code vs Codex); tools explain the conflict instead of a generic not-connected hint.
- README: how to load the same MCP server in the OpenAI Codex CLI.

## 1.0.0 — 2026-09-13
- Initial release. Connects the GM's browser to a local Claude Code MCP server so Claude can inspect and script the world directly (documents, flags, macros, module APIs). GM client only; connects to ws://localhost.
