import { readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { normalizeRepoPath, readJsonLines } from './utils.js';

/**
 * Encode a repo path to the Claude project directory name.
 * e.g. C:\xampp\htdocs\MyApp -> c--xampp-htdocs-MyApp
 * The drive letter is lowercased and colon removed, backslashes become dashes.
 */
function encodeClaudeProjectDir(repoPath) {
  // Normalize to forward slashes
  let p = repoPath.replace(/\\/g, '/');
  // Lowercase drive letter, replace colon with dash (so C: becomes c-)
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + '-' + p.slice(2);
  }
  // Replace slashes with dashes
  p = p.replace(/\//g, '-');
  return p;
}

/**
 * Discover Claude Code session files for the given repo.
 */
function discoverClaudeSessions(config) {
  const results = [];
  const claudeRoot = config.claudeRoot;

  if (!existsSync(claudeRoot)) return results;

  const encoded = encodeClaudeProjectDir(config.repoPath);
  // Try exact match and common case variants
  const candidates = [encoded, encoded.toLowerCase(), encoded.toUpperCase()];
  const tried = new Set();

  // Also scan for directories that match case-insensitively
  try {
    const dirs = readdirSync(claudeRoot);
    for (const dir of dirs) {
      if (dir.toLowerCase() === encoded.toLowerCase()) {
        candidates.push(dir);
      }
    }
  } catch {
    // ignore read errors
  }

  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    const projectDir = join(claudeRoot, candidate);
    if (!existsSync(projectDir)) continue;

    try {
      const stat = statSync(projectDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      const files = readdirSync(projectDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(projectDir, file);
        results.push({ filePath, provider: 'claude', archived: false });
      }
    } catch {
      // ignore read errors
    }
  }

  // Deduplicate by filePath
  const seen = new Set();
  return results.filter((r) => {
    if (seen.has(r.filePath)) return false;
    seen.add(r.filePath);
    return true;
  });
}

/**
 * Normalize a path for comparison: lowercase, forward slashes, trim trailing slash.
 */
function normalizePath(p) {
  if (!p) return '';
  let result = p.replace(/\\/g, '/').toLowerCase();
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Check if a session file's cwd matches the repo path.
 * Read first few lines to find session_meta.cwd or turn_context.cwd.
 */
function codexSessionMatchesRepo(filePath, repoPath) {
  const normalizedRepo = normalizePath(repoPath);

  try {
    const lines = readJsonLines(filePath);
    // Only check first 20 lines for performance
    const checkLines = lines.slice(0, 20);
    for (const { value } of checkLines) {
      // session_meta
      if (value.type === 'session_meta' && value.payload?.cwd) {
        const sessionCwd = normalizePath(value.payload.cwd);
        if (sessionCwd === normalizedRepo || sessionCwd.startsWith(normalizedRepo + '/')) {
          return true;
        }
      }
      // turn_context
      if (value.type === 'turn_context' && value.payload?.cwd) {
        const turnCwd = normalizePath(value.payload.cwd);
        if (turnCwd === normalizedRepo || turnCwd.startsWith(normalizedRepo + '/')) {
          return true;
        }
      }
    }
  } catch {
    // ignore read errors
  }

  return false;
}

/**
 * Recursively find all .jsonl files under a directory.
 */
function findJsonlFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore read errors
  }

  return results;
}

/**
 * Discover Codex session files for the given repo.
 */
function discoverCodexSessions(config, archived = false) {
  const results = [];
  const root = archived ? config.codexArchivedRoot : config.codexSessionsRoot;

  if (!existsSync(root)) return results;

  const jsonlFiles = findJsonlFiles(root);
  for (const filePath of jsonlFiles) {
    if (codexSessionMatchesRepo(filePath, config.repoPath)) {
      results.push({ filePath, provider: 'codex', archived });
    }
  }

  return results;
}

/**
 * Discover all session files (Claude + Codex) for the configured repo.
 */
export function discoverSessionFiles(config) {
  const results = [];

  // Claude Code sessions
  results.push(...discoverClaudeSessions(config));

  // Codex sessions
  results.push(...discoverCodexSessions(config, false));

  // Codex archived sessions
  if (config.includeArchived) {
    results.push(...discoverCodexSessions(config, true));
  }

  return results;
}
