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
  };
}
