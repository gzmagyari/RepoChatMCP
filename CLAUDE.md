# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (and CLI tool) that searches Claude Code and Codex CLI chat session histories. Zero dependencies, pure Node.js 22+, ES modules throughout.

## Commands

```bash
npm test                    # Run all tests (node --test tests/*.test.js)
npm start                   # Start MCP server (node ./bin/chat-search.js)
node --test tests/foo.test.js  # Run a single test file
npm link                    # Make `chat-search` available globally
```

## Architecture

The data flow is: **discovery → normalization → search/knowledge → MCP or CLI output**.

- **`src/discovery.js`** — Finds JSONL session files on disk. Claude sessions are located by encoding the repo path into a directory name under `~/.claude/projects/`. Codex sessions are found by recursively scanning `~/.codex/sessions/` and matching the `session_meta.cwd` field to the current repo.
- **`src/normalizer.js`** — Parses Claude and Codex JSONL formats into a unified message schema (`{ provider, sessionId, index, timestamp, type, role, text }`). Message types: `user`, `assistant`, `tool_call`, `tool_result`, `system`, `compaction`.
- **`src/search.js`** — Four query functions operating on normalized sessions: `searchMessages` (scored text search), `grepMessages` (pattern matching with `|`/`&`/regex), `readSession` (by index range), `readLines` (around keyword/regex with context).
- **`src/knowledge.js`** — Extracts high-signal content (compactions, long assistant messages) with scoring based on recency, length, and query relevance. Can write results to a temp markdown file.
- **`src/mcp/server.js`** — MCP server exposing 6 tools (`chat.list_sessions`, `chat.search`, `chat.grep`, `chat.read_session`, `chat.read_lines`, `chat.base_knowledge`). Uses a `SessionCache` that invalidates on file mtime/size changes.
- **`src/mcp/framing.js`** — Minimal JSON-RPC over stdio with `Content-Length` framing (MCP transport layer).
- **`src/config.js`** — Resolves config from CLI flags → env vars → defaults.
- **`src/cli.js`** — Entry point for `mcp`, `search`, and `status` subcommands.
- **`src/utils.js`** — Shared helpers: JSONL reader, text scoring, tokenizer, arg parser, path normalization.

## Key design decisions

- All file I/O is synchronous (`readFileSync`, `readdirSync`, `statSync`) — intentional for simplicity since sessions are local files.
- The MCP server caches parsed sessions and invalidates by checking file mtime + size on each request.
- Grep patterns use `&` for AND, `|` for OR, and `/regex/flags` for regex — this is a custom syntax, not standard grep.
- The `normalizeRepoPath` function lowercases drive letters and normalizes to forward slashes — this matters for cross-platform path matching.
