import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSession } from '../src/normalizer.js';
import { collectBaseKnowledge, writeKnowledgeToFile } from '../src/knowledge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function loadSessions() {
  const claude = normalizeSession(path.join(fixturesDir, 'claude-session.jsonl'), 'claude');
  const codex = normalizeSession(path.join(fixturesDir, 'codex-session.jsonl'), 'codex');
  return [claude, codex];
}

// ── collectBaseKnowledge tests ───────────────────────────────────────

test('collectBaseKnowledge: returns compaction entries from Codex', () => {
  const sessions = loadSessions();
  const entries = collectBaseKnowledge(sessions);
  const compactions = entries.filter((e) => e.type === 'compaction');
  assert.ok(compactions.length > 0, 'should include compaction entries');
  assert.equal(compactions[0].provider, 'codex');
  assert.ok(compactions[0].text.includes('Summary of session'), 'compaction text should be present');
});

test('collectBaseKnowledge: includes assistant messages as fallback knowledge', () => {
  // Use only Claude sessions which have no compactions but have long assistant messages
  const claude = normalizeSession(path.join(fixturesDir, 'claude-session.jsonl'), 'claude');
  const entries = collectBaseKnowledge([claude]);
  // The JWT explanation message is >200 chars so it should be included
  const assistantEntries = entries.filter((e) => e.type === 'assistant');
  assert.ok(assistantEntries.length > 0, 'should include long assistant messages');
});

test('collectBaseKnowledge: limit parameter works', () => {
  const sessions = loadSessions();
  const entries = collectBaseKnowledge(sessions, { limit: 2 });
  assert.ok(entries.length <= 2, `should return at most 2 entries, got ${entries.length}`);
});

test('collectBaseKnowledge: query keyword filter boosts relevant entries', () => {
  const sessions = loadSessions();
  const withQuery = collectBaseKnowledge(sessions, { query: 'database pooling' });
  const withoutQuery = collectBaseKnowledge(sessions, {});

  // Find the database-related entry in both
  const dbEntryWithQuery = withQuery.find((e) => e.text.toLowerCase().includes('database'));
  const dbEntryWithout = withoutQuery.find((e) => e.text.toLowerCase().includes('database'));

  if (dbEntryWithQuery && dbEntryWithout) {
    assert.ok(
      dbEntryWithQuery.score >= dbEntryWithout.score,
      'query-matched entry should have equal or higher score',
    );
  }
});

test('collectBaseKnowledge: provider filter restricts results', () => {
  const sessions = loadSessions();
  const entries = collectBaseKnowledge(sessions, { provider: 'codex' });
  for (const entry of entries) {
    assert.equal(entry.provider, 'codex', 'all entries should be from codex');
  }
});

// ── writeKnowledgeToFile tests ───────────────────────────────────────

test('writeKnowledgeToFile: creates a file and returns absolute path', () => {
  const sessions = loadSessions();
  const entries = collectBaseKnowledge(sessions, { limit: 3 });
  const filePath = writeKnowledgeToFile(entries);

  assert.ok(path.isAbsolute(filePath), 'returned path should be absolute');
  assert.ok(fs.existsSync(filePath), 'file should exist on disk');

  // Cleanup
  fs.unlinkSync(filePath);
});

test('writeKnowledgeToFile: file content is formatted markdown with provider and session info', () => {
  const sessions = loadSessions();
  const entries = collectBaseKnowledge(sessions, { limit: 3 });
  const filePath = writeKnowledgeToFile(entries);
  const content = fs.readFileSync(filePath, 'utf8');

  // Should contain markdown headers with provider and sessionId
  assert.ok(content.includes('##'), 'content should have markdown headers');
  assert.ok(content.includes('---'), 'content should have separator lines');

  // Should contain provider names in brackets
  const hasProvider = content.includes('[claude]') || content.includes('[codex]');
  assert.ok(hasProvider, 'content should include provider name in brackets');

  // Should contain session IDs
  const hasSessionId =
    content.includes('claude-test-session') || content.includes('codex-test-session');
  assert.ok(hasSessionId, 'content should include session ID');

  // Should contain actual message text
  assert.ok(content.length > 50, 'content should contain substantial text');

  // Cleanup
  fs.unlinkSync(filePath);
});
