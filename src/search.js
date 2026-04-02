import { scoreTextMatch, tokenize } from './utils.js';

/**
 * Get surrounding context messages for a given message index within a session.
 */
function getContext(messages, targetIndex, contextMessages) {
  if (!contextMessages || contextMessages <= 0) return { before: [], after: [] };

  const before = [];
  const after = [];

  for (let i = Math.max(0, targetIndex - contextMessages); i < targetIndex; i++) {
    before.push(messages[i]);
  }
  for (let i = targetIndex + 1; i <= Math.min(messages.length - 1, targetIndex + contextMessages); i++) {
    after.push(messages[i]);
  }

  return { before, after };
}

/**
 * Filter messages by optional criteria.
 */
function filterMessage(msg, { sessionId, provider, types }) {
  if (sessionId && msg.sessionId !== sessionId) return false;
  if (provider && msg.provider !== provider) return false;
  if (types && types.length > 0 && !types.includes(msg.type)) return false;
  return true;
}

/**
 * Search messages by text query with scoring.
 */
export function searchMessages(sessions, { query, sessionId, provider, types, limit = 20, contextMessages = 1 }) {
  const scored = [];

  for (const session of sessions) {
    const msgs = session.messages || [];
    for (const msg of msgs) {
      if (!filterMessage(msg, { sessionId, provider, types })) continue;

      const score = scoreTextMatch(msg.text, query);
      if (score > 0) {
        const ctx = getContext(msgs, msg.index, contextMessages);
        scored.push({
          message: msg,
          score,
          provider: msg.provider,
          sessionId: msg.sessionId,
          context: ctx,
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Build a matcher function from a grep pattern string.
 * Supports: OR groups separated by |, AND within groups separated by &,
 * regex patterns delimited by / ... / or / ... /i
 */
function buildMatcher(pattern, caseSensitive = true) {
  // Check for regex pattern: /pattern/ or /pattern/i
  if (pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    if (lastSlash > 0) {
      const regexBody = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      try {
        const re = new RegExp(regexBody, flags);
        return (text) => re.test(text);
      } catch {
        // Fall through to literal matching
      }
    }
  }

  const orGroups = pattern.split('|').map((g) => g.trim()).filter(Boolean);

  const matchers = orGroups.map((group) => {
    const andTokens = group.split('&').map((t) => t.trim()).filter(Boolean);
    return (text) => {
      const target = caseSensitive ? text : text.toLowerCase();
      return andTokens.every((token) => {
        const t = caseSensitive ? token : token.toLowerCase();
        return target.includes(t);
      });
    };
  });

  // OR: any group matches
  return (text) => matchers.some((m) => m(text));
}

/**
 * Grep messages by pattern (supports |, &, and regex).
 */
export function grepMessages(sessions, { pattern, sessionId, provider, types, limit = 20, contextMessages = 1, caseSensitive = true }) {
  const matcher = buildMatcher(pattern, caseSensitive);
  const results = [];

  for (const session of sessions) {
    const msgs = session.messages || [];
    for (const msg of msgs) {
      if (!filterMessage(msg, { sessionId, provider, types })) continue;

      if (matcher(msg.text || '')) {
        const ctx = getContext(msgs, msg.index, contextMessages);
        results.push({
          message: msg,
          provider: msg.provider,
          sessionId: msg.sessionId,
          context: ctx,
        });

        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

/**
 * Read messages from a specific session.
 */
export function readSession(sessions, { sessionId, provider, startIndex, endIndex, types, limit = 100 }) {
  const matching = sessions.filter((s) => {
    if (s.sessionId !== sessionId) return false;
    if (provider && s.provider !== provider) return false;
    return true;
  });

  if (matching.length === 0) return [];

  const session = matching[0];
  let msgs = session.messages || [];

  // Apply index range
  if (startIndex !== undefined || endIndex !== undefined) {
    const start = startIndex ?? 0;
    const end = endIndex ?? msgs.length - 1;
    msgs = msgs.filter((m) => m.index >= start && m.index <= end);
  }

  // Apply type filter
  if (types && types.length > 0) {
    msgs = msgs.filter((m) => types.includes(m.type));
  }

  // Apply limit
  return msgs.slice(0, limit).map((msg) => ({
    message: msg,
    provider: msg.provider,
    sessionId: msg.sessionId,
    context: { before: [], after: [] },
  }));
}

/**
 * Read specific lines or lines around a keyword/regex from a session.
 */
export function readLines(sessions, { sessionId, provider, startLine, endLine, aroundKeyword, aroundRegex, contextLines = 3 }) {
  const matching = sessions.filter((s) => {
    if (s.sessionId !== sessionId) return false;
    if (provider && s.provider !== provider) return false;
    return true;
  });

  if (matching.length === 0) return [];

  const session = matching[0];
  const msgs = session.messages || [];

  // By line range
  if (startLine !== undefined || endLine !== undefined) {
    const start = startLine ?? 0;
    const end = endLine ?? msgs.length - 1;
    return msgs
      .filter((m) => m.index >= start && m.index <= end)
      .map((msg) => ({
        message: msg,
        provider: msg.provider,
        sessionId: msg.sessionId,
        context: { before: [], after: [] },
      }));
  }

  // By keyword or regex
  let matcher = null;
  if (aroundRegex) {
    try {
      const re = new RegExp(aroundRegex, 'i');
      matcher = (text) => re.test(text);
    } catch {
      matcher = (text) => text.toLowerCase().includes(aroundRegex.toLowerCase());
    }
  } else if (aroundKeyword) {
    const kw = aroundKeyword.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(kw);
  }

  if (!matcher) return [];

  // Find matching messages and include context
  const matchIndices = new Set();
  for (const msg of msgs) {
    if (matcher(msg.text || '')) {
      matchIndices.add(msg.index);
    }
  }

  // Expand with context
  const includeIndices = new Set();
  for (const idx of matchIndices) {
    for (let i = idx - contextLines; i <= idx + contextLines; i++) {
      if (i >= 0 && i < msgs.length) {
        includeIndices.add(i);
      }
    }
  }

  const sortedIndices = [...includeIndices].sort((a, b) => a - b);
  return sortedIndices
    .map((idx) => msgs.find((m) => m.index === idx))
    .filter(Boolean)
    .map((msg) => {
      const ctx = getContext(msgs, msg.index, contextLines);
      return {
        message: msg,
        provider: msg.provider,
        sessionId: msg.sessionId,
        matched: matchIndices.has(msg.index),
        context: ctx,
      };
    });
}
