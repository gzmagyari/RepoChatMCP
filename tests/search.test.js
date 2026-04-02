import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSession } from '../src/normalizer.js';
import { searchMessages, grepMessages, readSession, readLines } from '../src/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function loadSessions() {
  const claude = normalizeSession(path.join(fixturesDir, 'claude-session.jsonl'), 'claude');
  const codex = normalizeSession(path.join(fixturesDir, 'codex-session.jsonl'), 'codex');
  return [claude, codex];
}

// ── searchMessages tests ─────────────────────────────────────────────

test('searchMessages: query "authentication" finds matching messages', () => {
  const sessions = loadSessions();
  const results = searchMessages(sessions, { query: 'authentication' });
  assert.ok(results.length > 0, 'should find at least one result');
  for (const r of results) {
    assert.ok(r.score > 0, 'each result should have a positive score');
    assert.ok(r.message, 'each result should have a message');
  }
  // The Claude messages about authentication should be found
  const texts = results.map((r) => r.message.text.toLowerCase());
  assert.ok(
    texts.some((t) => t.includes('authentication')),
    'should find messages containing "authentication"',
  );
});

test('searchMessages: sessionId filter restricts to one session', () => {
  const sessions = loadSessions();
  const results = searchMessages(sessions, {
    query: 'the',
    sessionId: 'claude-test-session',
  });
  for (const r of results) {
    assert.equal(r.sessionId, 'claude-test-session', 'all results should be from Claude session');
  }
});

test('searchMessages: types filter returns only specified types', () => {
  const sessions = loadSessions();
  const results = searchMessages(sessions, {
    query: 'the',
    types: ['user'],
  });
  for (const r of results) {
    assert.equal(r.message.type, 'user', 'all results should be user type');
  }
});

// ── grepMessages tests ───────────────────────────────────────────────

test('grepMessages: OR pattern "JWT|token" matches messages containing either', () => {
  const sessions = loadSessions();
  const results = grepMessages(sessions, { pattern: 'JWT|token', caseSensitive: false });
  assert.ok(results.length > 0, 'should find at least one result');
  for (const r of results) {
    const text = r.message.text.toLowerCase();
    assert.ok(
      text.includes('jwt') || text.includes('token'),
      `message should contain "jwt" or "token": "${text.slice(0, 80)}"`,
    );
  }
});

test('grepMessages: AND pattern "authentication&JWT" requires both', () => {
  const sessions = loadSessions();
  const results = grepMessages(sessions, { pattern: 'authentication&JWT', caseSensitive: false });
  assert.ok(results.length > 0, 'should find at least one result');
  for (const r of results) {
    const text = r.message.text.toLowerCase();
    assert.ok(text.includes('authentication'), 'message should contain "authentication"');
    assert.ok(text.includes('jwt'), 'message should contain "jwt"');
  }
});

test('grepMessages: regex pattern "/login/i" matches', () => {
  const sessions = loadSessions();
  const results = grepMessages(sessions, { pattern: '/login/i' });
  assert.ok(results.length > 0, 'should find at least one result');
  for (const r of results) {
    assert.ok(
      r.message.text.toLowerCase().includes('login'),
      'message should contain "login"',
    );
  }
});

// ── readSession tests ────────────────────────────────────────────────

test('readSession: returns messages in index order', () => {
  const sessions = loadSessions();
  const results = readSession(sessions, { sessionId: 'claude-test-session' });
  assert.ok(results.length > 0, 'should return messages');
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i].message.index > results[i - 1].message.index,
      'messages should be in ascending index order',
    );
  }
});

test('readSession: startIndex/endIndex returns range', () => {
  const sessions = loadSessions();
  const results = readSession(sessions, {
    sessionId: 'claude-test-session',
    startIndex: 1,
    endIndex: 3,
  });
  assert.ok(results.length > 0, 'should return messages');
  assert.ok(results.length <= 3, 'should return at most 3 messages');
  for (const r of results) {
    assert.ok(r.message.index >= 1 && r.message.index <= 3, `index ${r.message.index} should be in range [1,3]`);
  }
});

test('readSession: returns empty for unknown sessionId', () => {
  const sessions = loadSessions();
  const results = readSession(sessions, { sessionId: 'nonexistent' });
  assert.equal(results.length, 0);
});

// ── contextMessages tests ────────────────────────────────────────────

test('searchMessages: contextMessages includes surrounding messages', () => {
  const sessions = loadSessions();
  const results = searchMessages(sessions, {
    query: 'authentication and JWT tokens',
    contextMessages: 2,
  });
  assert.ok(results.length > 0, 'should find results');
  // Find the user message asking about authentication
  const authResult = results.find((r) => r.message.type === 'user' && r.message.text.includes('authentication and JWT'));
  if (authResult) {
    const ctx = authResult.context;
    assert.ok(ctx.before.length > 0 || ctx.after.length > 0, 'should have context messages');
  }
});

test('grepMessages: contextMessages includes surrounding messages', () => {
  const sessions = loadSessions();
  const results = grepMessages(sessions, {
    pattern: '/password/i',
    contextMessages: 1,
  });
  assert.ok(results.length > 0, 'should find results');
  // The assistant message about password hashing should have context
  const pwResult = results[0];
  assert.ok(pwResult.context, 'result should have context');
  assert.ok(
    pwResult.context.before.length > 0 || pwResult.context.after.length > 0,
    'should have at least one context message',
  );
});

// ── readLines tests ──────────────────────────────────────────────────

test('readLines: aroundKeyword returns messages with surrounding context', () => {
  const sessions = loadSessions();
  const results = readLines(sessions, {
    sessionId: 'codex-test-session',
    aroundKeyword: 'router',
    contextLines: 1,
  });
  assert.ok(results.length > 0, 'should find messages around keyword');
  const matched = results.filter((r) => r.matched);
  assert.ok(matched.length > 0, 'should have matched messages');
});
