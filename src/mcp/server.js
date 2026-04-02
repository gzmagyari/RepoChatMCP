import { statSync } from 'fs';
import { StdioJsonRpcServer } from './framing.js';
import { discoverSessionFiles } from '../discovery.js';
import { normalizeSession } from '../normalizer.js';
import { searchMessages, grepMessages, readSession, readLines } from '../search.js';
import {
  buildBaseKnowledgeResponse,
  buildCompactionKnowledgeResponse,
  runKnowledgeIndex,
} from '../knowledge-index.js';

export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export const SERVER_INFO = {
  name: 'chat-search',
  version: '0.1.6',
};

export function negotiateProtocolVersion(requestedVersion) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    return requestedVersion;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Session cache entry: stores normalized session data and file stat for invalidation.
 */
class SessionCache {
  constructor() {
    this.cache = new Map(); // key -> { session, mtime, size }
  }

  getKey(filePath, provider) {
    return `${provider}:${filePath}`;
  }

  get(filePath, provider) {
    const key = this.getKey(filePath, provider);
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if file has changed
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs !== entry.mtime || stat.size !== entry.size) {
        this.cache.delete(key);
        return null;
      }
    } catch {
      this.cache.delete(key);
      return null;
    }

    return entry.session;
  }

  set(filePath, provider, session) {
    const key = this.getKey(filePath, provider);
    try {
      const stat = statSync(filePath);
      this.cache.set(key, {
        session,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // If we can't stat, still cache but it won't survive invalidation
      this.cache.set(key, { session, mtime: 0, size: 0 });
    }
  }
}

/**
 * Load all sessions, using cache where possible.
 */
function loadSessions(sessionFiles, cache) {
  const sessions = [];
  for (const { filePath, provider } of sessionFiles) {
    let session = cache.get(filePath, provider);
    if (!session) {
      try {
        session = normalizeSession(filePath, provider);
        cache.set(filePath, provider, session);
      } catch (err) {
        // Skip files that fail to parse
        continue;
      }
    }
    sessions.push(session);
  }
  return sessions;
}

/**
 * MCP tool definitions.
 */
const TOOLS = [
  {
    name: 'chat.list_sessions',
    description: 'List discovered chat sessions for the current repo.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider: claude or codex' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions' },
      },
    },
  },
  {
    name: 'chat.search',
    description: 'Search chat messages by text query with relevance scoring.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query text' },
        sessionId: { type: 'string', description: 'Filter to specific session' },
        provider: { type: 'string', description: 'Filter by provider: claude or codex' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter by message types' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        contextMessages: { type: 'number', description: 'Context messages around each match (default 1)' },
      },
    },
  },
  {
    name: 'chat.grep',
    description: 'Grep chat messages by pattern (supports |, &, regex).',
    inputSchema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Grep pattern (| for OR, & for AND, /regex/ for regex)' },
        sessionId: { type: 'string', description: 'Filter to specific session' },
        provider: { type: 'string', description: 'Filter by provider: claude or codex' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter by message types' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        contextMessages: { type: 'number', description: 'Context messages around each match (default 1)' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive matching (default true)' },
      },
    },
  },
  {
    name: 'chat.read_session',
    description: 'Read messages from a specific session.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID to read' },
        provider: { type: 'string', description: 'Provider hint: claude or codex' },
        startIndex: { type: 'number', description: 'Start message index' },
        endIndex: { type: 'number', description: 'End message index' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter by message types' },
        limit: { type: 'number', description: 'Max messages (default 100)' },
      },
    },
  },
  {
    name: 'chat.read_lines',
    description: 'Read specific lines or lines around a keyword/regex from a session.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID to read' },
        provider: { type: 'string', description: 'Provider hint: claude or codex' },
        startLine: { type: 'number', description: 'Start line (message index)' },
        endLine: { type: 'number', description: 'End line (message index)' },
        aroundKeyword: { type: 'string', description: 'Find messages containing keyword' },
        aroundRegex: { type: 'string', description: 'Find messages matching regex' },
        contextLines: { type: 'number', description: 'Context lines around matches (default 3)' },
      },
    },
  },
  {
    name: 'chat.base_knowledge',
    description: 'Collect persisted repository knowledge metadata and return absolute file paths for indexed knowledge snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider: claude or codex' },
      },
    },
  },
  {
    name: 'chat.compaction_knowledge',
    description: 'Collect live compaction knowledge metadata and return an absolute file path for the compaction snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Filter by provider: claude or codex' },
        limit: { type: 'number', description: 'Max entries (default 20)' },
        query: { type: 'string', description: 'Optional query to boost relevant compactions' },
      },
    },
  },
  {
    name: 'chat.knowledge_index',
    description: 'Build or refresh the persisted repository knowledge index from all chat history.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional provider filter: claude or codex' },
        force: { type: 'boolean', description: 'Force a full rebuild of the persisted knowledge index' },
      },
    },
  },
];

export function createMcpRequestHandler(config) {
  const cache = new SessionCache();
  let sessionFiles = null;

  function ensureDiscovered() {
    if (!sessionFiles) {
      sessionFiles = discoverSessionFiles(config);
    }
    return sessionFiles;
  }

  function getSessions(providerFilter) {
    const files = ensureDiscovered();
    const filtered = providerFilter
      ? files.filter((f) => f.provider === providerFilter)
      : files;
    return loadSessions(filtered, cache);
  }

  async function handleToolCall(name, params = {}) {
    switch (name) {
      case 'chat.list_sessions': {
        const files = ensureDiscovered();
        const filtered = params.provider
          ? files.filter((f) => f.provider === params.provider)
          : files;
        const sessions = loadSessions(filtered, cache);
        return sessions.map((s) => ({
          provider: s.provider,
          sessionId: s.sessionId,
          cwd: s.cwd,
          gitBranch: s.gitBranch,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          messageCount: s.messageCount,
        }));
      }

      case 'chat.search': {
        const sessions = getSessions(params.provider);
        return searchMessages(sessions, {
          query: params.query,
          sessionId: params.sessionId,
          provider: params.provider,
          types: params.types,
          limit: params.limit ?? config.defaultLimit,
          contextMessages: params.contextMessages ?? config.defaultContextMessages,
        });
      }

      case 'chat.grep': {
        const sessions = getSessions(params.provider);
        return grepMessages(sessions, {
          pattern: params.pattern,
          sessionId: params.sessionId,
          provider: params.provider,
          types: params.types,
          limit: params.limit ?? config.defaultLimit,
          contextMessages: params.contextMessages ?? config.defaultContextMessages,
          caseSensitive: params.caseSensitive ?? true,
        });
      }

      case 'chat.read_session': {
        const sessions = getSessions(params.provider);
        return readSession(sessions, {
          sessionId: params.sessionId,
          provider: params.provider,
          startIndex: params.startIndex,
          endIndex: params.endIndex,
          types: params.types,
          limit: params.limit ?? 100,
        });
      }

      case 'chat.read_lines': {
        const sessions = getSessions(params.provider);
        return readLines(sessions, {
          sessionId: params.sessionId,
          provider: params.provider,
          startLine: params.startLine,
          endLine: params.endLine,
          aroundKeyword: params.aroundKeyword,
          aroundRegex: params.aroundRegex,
          contextLines: params.contextLines ?? 3,
        });
      }

      case 'chat.base_knowledge': {
        const sessions = getSessions(params.provider);
        return buildBaseKnowledgeResponse(sessions, config, {
          provider: params.provider,
        });
      }

      case 'chat.compaction_knowledge': {
        const sessions = getSessions(params.provider);
        return buildCompactionKnowledgeResponse(sessions, config, {
          limit: params.limit ?? 20,
          query: params.query,
          provider: params.provider,
        });
      }

      case 'chat.knowledge_index': {
        const sessions = getSessions(params.provider);
        return await runKnowledgeIndex(sessions, config, {
          provider: params.provider,
          force: params.force === true,
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return async function handleRequest(message) {
    const { method, params } = message;

    if (method === 'initialize') {
      return {
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: SERVER_INFO,
      };
    }

    if (method === 'ping') {
      return {};
    }

    if (method === 'tools/list') {
      return { tools: TOOLS };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolParams = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolParams);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }

    throw new Error(`Unknown method: ${method}`);
  };
}

/**
 * Run the MCP server.
 */
export async function runMcpServer(config) {
  const handleRequest = createMcpRequestHandler(config);

  const server = new StdioJsonRpcServer({
    onRequest: handleRequest,
    onNotification: async () => {},
  });

  server.start();
}
