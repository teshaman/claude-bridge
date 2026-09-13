# claude-bridge — Changelog

All notable changes to this module. Newest version first.
Older packaged zips are kept in `backups/` and are never deleted.

## 1.0.1 — 2026-09-14
- Clear message when the bridge port is already held by another assistant (Claude Code vs Codex); tools explain the conflict instead of a generic not-connected hint.
- README: how to load the same MCP server in the OpenAI Codex CLI.

## 1.0.0 — 2026-09-13
- Initial release. Connects the GM's browser to a local Claude Code MCP server so Claude can inspect and script the world directly (documents, flags, macros, module APIs). GM client only; connects to ws://localhost.
