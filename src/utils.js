import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/**
 * Simple CLI arg parser. Supports --key value, --key=value, --flag (boolean).
 * Non-flag arguments go into result._
 */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        const key = arg.slice(2, eqIndex);
        const val = arg.slice(eqIndex + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { _: positional, flags };
}

/**
 * Try JSON.parse, return null on failure.
 */
export function maybeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read a JSONL file, return array of { lineNumber, value }.
 */
export function readJsonLines(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const value = maybeParseJson(line);
    if (value !== null) {
      results.push({ lineNumber: i + 1, value });
    }
  }
  return results;
}

/**
 * Truncate text with ellipsis.
 */
export function clip(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

/**
 * Split text into lowercase tokens (split on non-alphanumeric, filter length >= 2).
 */
export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Score text against a query string.
 * Full match of query in text: +8
 * Per-token: exact match +2, partial match +1
 */
export function scoreTextMatch(text, query) {
  if (!text || !query) return 0;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;

  // Full match bonus
  if (lowerText.includes(lowerQuery)) {
    score += 8;
  }

  // Per-token scoring
  const queryTokens = tokenize(query);
  for (const token of queryTokens) {
    if (lowerText.includes(token)) {
      // Check for word-boundary match
      const wordBoundary = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (wordBoundary.test(lowerText)) {
        score += 2;
      } else {
        score += 1;
      }
    }
  }

  return score;
}

/**
 * Normalize path separators, lowercase drive letter on Windows.
 */
export function normalizeRepoPath(input) {
  if (!input) return input;
  let p = input.replace(/\\/g, '/');
  // Lowercase drive letter on Windows (e.g. C:/ -> c:/)
  if (/^[A-Z]:\//.test(p)) {
    p = p[0].toLowerCase() + p.slice(1);
  }
  // Trim trailing slash
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Current time as ISO string.
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Slugify text: lowercase, replace non-alphanumeric with dashes.
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * SHA1 hex digest of text.
 */
export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Deduplicate array (using Set).
 */
export function unique(items) {
  return [...new Set(items)];
}
