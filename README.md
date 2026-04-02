# chat-search

MCP server that lets any AI agent search through Claude Code and Codex CLI chat session histories. Both providers are normalized into a unified format so you can search across all your coding sessions in one place.

Zero dependencies. Reads JSONL session files directly from disk. No database, no setup.

## Install

```bash
npm install
npm link  # optional, makes `chat-search` available globally
```

Requires Node.js 22+.

## Quick start

```bash
# Start as an MCP server (default — used by Claude Code, Codex, or any MCP client)
chat-search mcp --repo /path/to/your/repo

# Check what sessions are available
chat-search status --repo /path/to/your/repo

# Search from the command line
chat-search search --query "authentication" --repo /path/to/your/repo
```

If `--repo` is omitted, the current working directory is used.

## MCP tools

### `chat.list_sessions`

List all discovered sessions for the repo.

```json
{ "provider": "codex", "limit": 10 }
```

### `chat.search`

Keyword search with relevance scoring across all sessions.

```json
{ "query": "JWT token security", "provider": "claude", "types": ["assistant"], "limit": 5 }
```

### `chat.grep`

Pattern matching with AND/OR/regex support.

```json
{ "pattern": "winEscapeArg&spawnCommand" }
{ "pattern": "authentication|login|session" }
{ "pattern": "/function\\s+\\w+Auth/i" }
```

### `chat.read_session`

Read messages from a specific session by ID.

```json
{ "sessionId": "8ac646f8-1bec-...", "startIndex": 0, "endIndex": 50 }
```

### `chat.read_lines`

Read lines around keyword or regex matches in a session.

```json
{ "sessionId": "8ac646f8-...", "aroundKeyword": "database", "contextLines": 3 }
```

### `chat.base_knowledge`

Get a quick knowledge primer — returns the latest compactions (Codex) and high-signal assistant messages.

```json
{ "limit": 10, "query": "auth", "writeToFile": true }
```

When `writeToFile` is true, writes results to a temp markdown file and returns the path instead of inline content.

## Unified message format

Messages from both Claude Code and Codex are normalized to:

```javascript
{
  provider: "claude" | "codex",
  sessionId: "uuid...",
  index: 42,
  timestamp: "2026-03-25T...",
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "compaction",
  role: "user" | "assistant" | "system" | "developer" | "tool",
  text: "..."
}
```

| Source | Normalized type |
|---|---|
| Claude user message | `user` |
| Claude assistant message | `assistant` |
| Claude assistant with tool_use | `tool_call` |
| Claude user with tool_result | `tool_result` |
| Claude system message | `system` |
| Codex user response_item | `user` |
| Codex assistant response_item | `assistant` |
| Codex developer response_item | `system` |
| Codex compacted entry | `compaction` |

## Where session files live

**Claude Code**: `~/.claude/projects/<encoded-repo-path>/*.jsonl`

The repo path is encoded as: drive letter lowercased, colon replaced with dash, slashes replaced with dashes. For example `C:\xampp\htdocs\MyApp` becomes `c--xampp-htdocs-MyApp`.

**Codex**: `~/.codex/sessions/<year>/<month>/<day>/*.jsonl`

Codex sessions are matched to repos by reading the `session_meta` entry's `cwd` field.

Both paths are configurable via `--claude-root` and `--codex-sessions` flags or `CHAT_SEARCH_CLAUDE_ROOT` and `CHAT_SEARCH_CODEX_SESSIONS` environment variables.

## Use as an MCP in Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "chat-search": {
      "command": "node",
      "args": ["/path/to/chat-search/bin/chat-search.js", "mcp"]
    }
  }
}
```

Claude Code sets the working directory automatically, so the MCP will discover sessions for whatever repo you're in.

## Use as an MCP in Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.chat_search]
command = "node"
args = ["/path/to/chat-search/bin/chat-search.js", "mcp"]
```

## Tests

```bash
npm test
```

35 unit tests covering normalization, search, grep, knowledge collection, and MCP protocol integration.

## License

MIT
