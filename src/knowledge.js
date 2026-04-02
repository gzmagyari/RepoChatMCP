import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize, sha1, nowIso, clip } from './utils.js';

/**
 * Collect base knowledge from sessions: compactions + high-signal assistant messages.
 */
export function collectBaseKnowledge(sessions, { limit = 20, query, provider } = {}) {
  const entries = [];
  const now = Date.now();
  const queryTokens = query ? tokenize(query) : [];

  for (const session of sessions) {
    if (provider && session.provider !== provider) continue;

    const msgs = session.messages || [];

    for (const msg of msgs) {
      let score = 0;
      let include = false;

      // Compaction entries always included
      if (msg.type === 'compaction') {
        score += 10;
        include = true;
      }

      // Long assistant messages that look like explanations
      if (msg.type === 'assistant' && msg.text && msg.text.length > 200) {
        include = true;
      }

      if (!include) continue;

      // Length bonus (capped at +5)
      const textLen = (msg.text || '').length;
      score += Math.min(5, Math.floor(textLen / 500));

      // Recency bonus: parse timestamp, newer = higher score
      if (msg.timestamp) {
        const age = now - new Date(msg.timestamp).getTime();
        const hoursOld = age / (1000 * 60 * 60);
        if (hoursOld < 24) score += 5;
        else if (hoursOld < 168) score += 3; // within a week
        else if (hoursOld < 720) score += 1; // within a month
      }

      // Query keyword match bonus
      if (queryTokens.length > 0 && msg.text) {
        const lowerText = msg.text.toLowerCase();
        for (const token of queryTokens) {
          if (lowerText.includes(token)) {
            score += 2;
          }
        }
      }

      entries.push({
        provider: msg.provider,
        sessionId: msg.sessionId,
        index: msg.index,
        timestamp: msg.timestamp,
        type: msg.type,
        text: msg.text || '',
        score,
      });
    }
  }

  // Sort by score descending
  entries.sort((a, b) => b.score - a.score);

  return entries.slice(0, limit);
}

/**
 * Write knowledge entries to a temp file as formatted markdown.
 * Returns the absolute file path.
 */
export function writeKnowledgeToFile(entries) {
  const parts = [];
  for (const entry of entries) {
    parts.push(`## [${entry.provider}] ${entry.sessionId}`);
    parts.push('');
    parts.push(entry.text);
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  const content = parts.join('\n');
  const hash = sha1(content).slice(0, 8);
  const fileName = `chat-knowledge-${hash}.md`;
  const filePath = join(tmpdir(), fileName);

  writeFileSync(filePath, content, 'utf8');
  return filePath;
}
