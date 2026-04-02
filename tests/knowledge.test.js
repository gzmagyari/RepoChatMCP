import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeSession } from '../src/normalizer.js';
import { collectCompactionKnowledge, writeCompactionKnowledgeToFile } from '../src/knowledge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function loadSessions() {
  const claude = normalizeSession(path.join(fixturesDir, 'claude-session.jsonl'), 'claude');
  const codex = normalizeSession(path.join(fixturesDir, 'codex-session.jsonl'), 'codex');
  return [claude, codex];
}

test('collectCompactionKnowledge: uses replacement_history fallback for modern Codex compactions', () => {
  const modernCodex = normalizeSession(
    path.join(fixturesDir, 'codex-session-modern-compaction.jsonl'),
    'codex',
  );
  const entries = collectCompactionKnowledge([modernCodex]);

  assert.equal(entries.length, 1, 'should include the modern compaction entry');
  assert.ok(entries[0].text.length > 0, 'fallback compaction text should not be empty');
  assert.ok(
    entries[0].text.includes('replacement history fallback'),
    'should preserve the fallback note for modern Codex compactions',
  );
});

test('collectCompactionKnowledge: returns compaction entries from Codex', () => {
  const sessions = loadSessions();
  const entries = collectCompactionKnowledge(sessions);

  assert.ok(entries.length > 0, 'should include compaction entries');
  assert.equal(entries[0].provider, 'codex');
  assert.equal(entries[0].type, 'compaction');
  assert.ok(entries[0].text.includes('Summary of session'), 'compaction text should be present');
});

test('collectCompactionKnowledge: excludes long assistant fallback messages', () => {
  const claude = normalizeSession(path.join(fixturesDir, 'claude-session.jsonl'), 'claude');
  const entries = collectCompactionKnowledge([claude]);

  assert.equal(entries.length, 0, 'should not include assistant messages');
});

test('collectCompactionKnowledge: limit parameter works', () => {
  const sessions = loadSessions();
  const entries = collectCompactionKnowledge(sessions, { limit: 1 });
  assert.ok(entries.length <= 1, `should return at most 1 entry, got ${entries.length}`);
});

test('collectCompactionKnowledge: query keyword filter boosts relevant entries', () => {
  const sessions = loadSessions();
  const withQuery = collectCompactionKnowledge(sessions, { query: 'database' });
  const withoutQuery = collectCompactionKnowledge(sessions, {});

  const matchingWithQuery = withQuery.find((entry) => entry.text.toLowerCase().includes('database'));
  const matchingWithoutQuery = withoutQuery.find((entry) => entry.text.toLowerCase().includes('database'));

  if (matchingWithQuery && matchingWithoutQuery) {
    assert.ok(
      matchingWithQuery.score >= matchingWithoutQuery.score,
      'query-matched compaction should have equal or higher score',
    );
  }
});

test('collectCompactionKnowledge: provider filter restricts results', () => {
  const sessions = loadSessions();
  const entries = collectCompactionKnowledge(sessions, { provider: 'codex' });
  for (const entry of entries) {
    assert.equal(entry.provider, 'codex', 'all entries should be from codex');
  }
});

test('writeCompactionKnowledgeToFile: creates a file and returns absolute path', () => {
  const sessions = loadSessions();
  const entries = collectCompactionKnowledge(sessions, { limit: 3 });
  const filePath = writeCompactionKnowledgeToFile(entries);

  assert.ok(path.isAbsolute(filePath), 'returned path should be absolute');
  assert.ok(fs.existsSync(filePath), 'file should exist on disk');

  fs.unlinkSync(filePath);
});

test('writeCompactionKnowledgeToFile: file content is formatted markdown with provider and session info', () => {
  const sessions = loadSessions();
  const entries = collectCompactionKnowledge(sessions, { limit: 3 });
  const filePath = writeCompactionKnowledgeToFile(entries);
  const content = fs.readFileSync(filePath, 'utf8');

  assert.ok(content.includes('# Live Compaction Knowledge'), 'content should have the compaction heading');
  assert.ok(content.includes('##'), 'content should have markdown headers');
  assert.ok(content.includes('---'), 'content should have separator lines');
  assert.ok(content.includes('[codex]'), 'content should include provider name in brackets');
  assert.ok(content.includes('codex-test-session'), 'content should include session ID');
  assert.ok(content.length > 50, 'content should contain substantial text');

  fs.unlinkSync(filePath);
});
