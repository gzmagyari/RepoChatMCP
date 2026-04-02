# RepoChatMCP

Search Claude Code and Codex chat history like source code.

[![npm version](https://img.shields.io/npm/v/chat-search-mcp?style=for-the-badge)](https://www.npmjs.com/package/chat-search-mcp)
[![node >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/gzmagyari/RepoChatMCP?style=for-the-badge)](https://github.com/gzmagyari/RepoChatMCP)
[![MIT license](https://img.shields.io/github/license/gzmagyari/RepoChatMCP?style=for-the-badge)](https://github.com/gzmagyari/RepoChatMCP/blob/main/LICENSE)

RepoChatMCP is a zero-dependency MCP server and CLI for searching local Claude Code and Codex session files. It normalizes both providers into one message model, exposes search and read tools over MCP, and can optionally build a persisted repository knowledge index from your chat history.

No database. No background service. No telemetry. Just your local JSONL session files.

## Why Use It

- Search Claude Code and Codex history from one MCP server
- Read sessions by message range or lines around a match
- Grep chats with AND, OR, and regex patterns
- Build repo knowledge summaries from prior chats
- Run locally with zero runtime dependencies

## Package And Commands

- Published npm package: `chat-search-mcp`
- Installed CLI commands: `chat-search` and `chat-search-mcp`
- Runtime requirement: Node.js 22+

## Install

### Use the published npm package

Install it first:

```bash
npm install -g chat-search-mcp@latest
```

Then use it:

```bash
chat-search status --repo /path/to/repo
chat-search search "authentication" --repo /path/to/repo
```

### Use the local repo checkout

```bash
git clone https://github.com/gzmagyari/RepoChatMCP.git
cd RepoChatMCP
npm install
node ./bin/chat-search.js status --repo .
```

## Claude Code Setup

### Project MCP from a local checkout

Use this when you cloned the repo and want Claude Code to run the local source directly:

```json
{
  "mcpServers": {
    "chat-search": {
      "type": "stdio",
      "command": "node",
      "args": ["./bin/chat-search.js"]
    }
  }
}
```

Claude Code runs project MCPs from the repo directory, so `./bin/chat-search.js` works and the current repo becomes the default target.

### Use the published npm package

Install it first:

```bash
npm install -g chat-search-mcp@latest
```

macOS / Linux:

```json
{
  "mcpServers": {
    "chat-search": {
      "type": "stdio",
      "command": "chat-search-mcp",
      "args": ["mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "chat-search": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "chat-search-mcp", "mcp"]
    }
  }
}
```

## Codex Setup

Local checkout:

```toml
[mcp_servers.chat_search]
command = "node"
args = ["C:/path/to/RepoChatMCP/bin/chat-search.js"]
```

Published npm package on Windows:

```toml
[mcp_servers.chat_search]
command = "cmd"
args = ["/c", "chat-search-mcp", "mcp"]
```

## CLI Quick Start

```bash
# MCP server
chat-search mcp --repo /path/to/repo

# Show discovered session counts
chat-search status --repo /path/to/repo

# Search across chats
chat-search search "jwt token" --repo /path/to/repo
```

If `--repo` is omitted, the current working directory is used.

## MCP Tools

| Tool | What it does |
|---|---|
| `chat.list_sessions` | Lists discovered Claude Code and Codex sessions for the repo |
| `chat.search` | Full-text search with relevance scoring |
| `chat.grep` | Pattern search with `|`, `&`, and regex support |
| `chat.read_session` | Reads messages from a session by index range |
| `chat.read_lines` | Reads lines around a keyword or regex match |
| `chat.base_knowledge` | Returns metadata plus absolute file paths for the live and persisted knowledge snapshots |
| `chat.knowledge_index` | Builds or refreshes persisted repository knowledge under `.repochatmcp/knowledge/` |

### Example tool inputs

```json
{ "query": "database pooling", "provider": "claude", "limit": 5 }
```

```json
{ "pattern": "authentication&jwt" }
```

```json
{ "sessionId": "8ac646f8-1bec-...", "startIndex": 0, "endIndex": 50 }
```

```json
{ "force": true }
```

## Optional Knowledge Indexing

Knowledge indexing is disabled by default.

When disabled:

- `chat.base_knowledge` still returns persisted knowledge file paths if prior indexed runs already exist, plus the live heuristic snapshot file path
- `chat.knowledge_index` returns a configuration message instead of indexing

When enabled:

- `chat.knowledge_index` summarizes new chat history into persisted markdown files
- `chat.base_knowledge` returns absolute paths for the merged snapshot, the live heuristic snapshot, and the persisted indexed run files
- `.repochatmcp/` is automatically added to the repo root `.gitignore`

Stored files:

- `.repochatmcp/knowledge/manifest.json`
- `.repochatmcp/knowledge/runs/*.md`

Indexing rules:

- minimum 100 new or changed messages before indexing runs
- split only when transcript size exceeds `CHAT_SEARCH_KNOWLEDGE_MAX_CHARS`
- Codex chunk calls run sequentially
- HTTP chunk calls run with limited concurrency

### Backends

- `off`: disabled
- `auto`: prefer HTTP if API config is present, otherwise use Codex CLI
- `http`: OpenAI-compatible HTTP requests
- `codex`: Codex CLI over stdin

### MCP env config

```json
{
  "mcpServers": {
    "chat-search": {
      "type": "stdio",
      "command": "cmd",
      "args": ["/c", "chat-search-mcp", "mcp"],
      "env": {
        "CHAT_SEARCH_KNOWLEDGE_BACKEND": "http",
        "CHAT_SEARCH_KNOWLEDGE_MODEL": "gpt-4.1-mini",
        "CHAT_SEARCH_KNOWLEDGE_API_KEY": "your-api-key",
        "CHAT_SEARCH_KNOWLEDGE_MAX_CHARS": "500000",
        "CHAT_SEARCH_KNOWLEDGE_HTTP_CONCURRENCY": "3"
      }
    }
  }
}
```

Supported env vars:

- `CHAT_SEARCH_KNOWLEDGE_BACKEND=off|auto|http|codex`
- `CHAT_SEARCH_KNOWLEDGE_MODEL`
- `CHAT_SEARCH_KNOWLEDGE_BASE_URL`
- `CHAT_SEARCH_KNOWLEDGE_API_KEY`
- `CHAT_SEARCH_KNOWLEDGE_MAX_CHARS`
- `CHAT_SEARCH_KNOWLEDGE_TIMEOUT_MS`
- `CHAT_SEARCH_KNOWLEDGE_CODEX_BIN`
- `CHAT_SEARCH_KNOWLEDGE_HTTP_CONCURRENCY`

## Unified Message Model

Both Claude Code and Codex are normalized to:

```js
{
  provider: "claude" | "codex",
  sessionId: "uuid-or-session-id",
  index: 42,
  timestamp: "2026-03-25T10:11:12.000Z",
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "compaction",
  role: "user" | "assistant" | "system" | "developer",
  text: "message text"
}
```

## Where Sessions Are Read From

Claude Code:

- `~/.claude/projects/<encoded-repo-path>/*.jsonl`

Codex:

- `~/.codex/sessions/<year>/<month>/<day>/*.jsonl`
- `~/.codex/archived_sessions/...`

Configurable roots:

- `CHAT_SEARCH_CLAUDE_ROOT`
- `CHAT_SEARCH_CODEX_SESSIONS`
- `CHAT_SEARCH_CODEX_ARCHIVED`

## Development

```bash
npm test
```

Current test suite: 57 tests covering discovery, normalization, search, MCP transport, live knowledge extraction, and persisted knowledge indexing.

## License

MIT
