import { join } from 'path';
import { homedir } from 'os';
import { normalizeRepoPath } from './utils.js';

function defaultClaudeRoot() {
  return join(homedir(), '.claude', 'projects');
}

function defaultCodexSessionsRoot() {
  return join(homedir(), '.codex', 'sessions');
}

function defaultCodexArchivedRoot() {
  return join(homedir(), '.codex', 'archived_sessions');
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveKnowledgeConfig(flags = {}) {
  const backend = (flags['knowledge-backend'] || process.env.CHAT_SEARCH_KNOWLEDGE_BACKEND || 'off')
    .toString()
    .toLowerCase();

  return {
    backend,
    model: flags['knowledge-model'] || process.env.CHAT_SEARCH_KNOWLEDGE_MODEL || null,
    baseUrl: flags['knowledge-base-url'] || process.env.CHAT_SEARCH_KNOWLEDGE_BASE_URL || null,
    apiKey: flags['knowledge-api-key'] || process.env.CHAT_SEARCH_KNOWLEDGE_API_KEY || null,
    maxChars: parseInteger(
      flags['knowledge-max-chars'] || process.env.CHAT_SEARCH_KNOWLEDGE_MAX_CHARS,
      500000,
    ),
    timeoutMs: parseInteger(
      flags['knowledge-timeout-ms'] || process.env.CHAT_SEARCH_KNOWLEDGE_TIMEOUT_MS,
      120000,
    ),
    codexBin: flags['knowledge-codex-bin'] || process.env.CHAT_SEARCH_KNOWLEDGE_CODEX_BIN || 'codex',
    httpConcurrency: Math.max(
      1,
      parseInteger(
        flags['knowledge-http-concurrency'] || process.env.CHAT_SEARCH_KNOWLEDGE_HTTP_CONCURRENCY,
        3,
      ),
    ),
  };
}

/**
 * Resolve configuration from CLI flags and environment variables.
 */
export function resolveConfig(flags = {}) {
  return {
    repoPath: normalizeRepoPath(flags.repo || process.env.CHAT_SEARCH_REPO_PATH || process.cwd()),
    claudeRoot: flags['claude-root'] || process.env.CHAT_SEARCH_CLAUDE_ROOT || defaultClaudeRoot(),
    codexSessionsRoot: flags['codex-sessions'] || process.env.CHAT_SEARCH_CODEX_SESSIONS || defaultCodexSessionsRoot(),
    codexArchivedRoot: flags['codex-archived'] || process.env.CHAT_SEARCH_CODEX_ARCHIVED || defaultCodexArchivedRoot(),
    includeArchived: flags['include-archived'] !== false,
    defaultLimit: 20,
    defaultContextMessages: 1,
    knowledge: resolveKnowledgeConfig(flags),
  };
}
