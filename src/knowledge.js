import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize, sha1 } from './utils.js';

/**
 * Collect live compaction knowledge from sessions.
 */
export function collectCompactionKnowledge(sessions, { limit = 20, query, provider } = {}) {
  const entries = [];
  const now = Date.now();
  const queryTokens = query ? tokenize(query) : [];

  for (const session of sessions) {
    if (provider && session.provider !== provider) continue;

    for (const msg of session.messages || []) {
      if (msg.type !== 'compaction') continue;

      let score = 10;
      const text = msg.text || '';

      score += Math.min(5, Math.floor(text.length / 500));

      if (msg.timestamp) {
        const age = now - new Date(msg.timestamp).getTime();
        const hoursOld = age / (1000 * 60 * 60);
        if (hoursOld < 24) score += 5;
        else if (hoursOld < 168) score += 3;
        else if (hoursOld < 720) score += 1;
      }

      if (queryTokens.length > 0 && text) {
        const lowerText = text.toLowerCase();
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
        text,
        score,
      });
    }
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}

export function renderCompactionKnowledge(entries) {
  if (!entries || entries.length === 0) {
    return '';
  }

  const parts = ['# Live Compaction Knowledge', ''];
  for (const entry of entries) {
    parts.push(
      `## [${entry.provider}] ${entry.sessionId}#${entry.index} (${entry.type}${entry.timestamp ? `, ${entry.timestamp}` : ''})`,
    );
    parts.push('');
    parts.push(entry.text);
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  return parts.join('\n').trim();
}

export function writeKnowledgeTextToFile(content) {
  const hash = sha1(content).slice(0, 8);
  const fileName = `chat-knowledge-${hash}.md`;
  const filePath = join(tmpdir(), fileName);

  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Write compaction knowledge entries to a temp file as formatted markdown.
 * Returns the absolute file path.
 */
export function writeCompactionKnowledgeToFile(entries) {
  return writeKnowledgeTextToFile(renderCompactionKnowledge(entries));
}
