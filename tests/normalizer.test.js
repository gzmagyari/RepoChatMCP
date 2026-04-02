import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSession } from '../src/normalizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const claudeFixture = path.join(fixturesDir, 'claude-session.jsonl');
const codexFixture = path.join(fixturesDir, 'codex-session.jsonl');
const codexModernCompactionFixture = path.join(fixturesDir, 'codex-session-modern-compaction.jsonl');

// ── Claude session tests ─────────────────────────────────────────────

test('Claude: returns session with correct sessionId, provider, and messageCount', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  assert.equal(session.sessionId, 'claude-test-session');
  assert.equal(session.provider, 'claude');
  assert.equal(session.messageCount, 7);
});

test('Claude: all messages have unified type, role, provider, sessionId, and text fields', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  for (const msg of session.messages) {
    assert.ok(typeof msg.type === 'string', `message index ${msg.index} missing type`);
    assert.ok(typeof msg.role === 'string', `message index ${msg.index} missing role`);
    assert.equal(msg.provider, 'claude');
    assert.equal(msg.sessionId, 'claude-test-session');
    assert.ok(typeof msg.text === 'string', `message index ${msg.index} missing text`);
    assert.ok(typeof msg.index === 'number', `message index ${msg.index} missing index`);
  }
});

test('Claude: tool_use content produces type tool_call', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  const toolCall = session.messages.find((m) => m.type === 'tool_call');
  assert.ok(toolCall, 'should have a tool_call message');
  assert.equal(toolCall.role, 'assistant');
  assert.ok(toolCall.text.includes('[tool: Read]'), 'text should include tool name');
  assert.ok(toolCall.text.includes('src/auth.js'), 'text should include tool input');
});

test('Claude: tool_result content produces type tool_result', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  const toolResult = session.messages.find((m) => m.type === 'tool_result');
  assert.ok(toolResult, 'should have a tool_result message');
  assert.equal(toolResult.role, 'user');
  assert.ok(toolResult.text.includes('[result]'), 'text should include [result] prefix');
  assert.ok(toolResult.text.includes('verifyToken'), 'text should include tool result content');
});

test('Claude: system message produces type system', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  const sysMsg = session.messages.find((m) => m.type === 'system');
  assert.ok(sysMsg, 'should have a system message');
  assert.equal(sysMsg.role, 'system');
  assert.ok(sysMsg.text.includes('git status'), 'text should include system content');
});

test('Claude: cwd and gitBranch are extracted', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  assert.equal(session.cwd, '/tmp/test-repo');
  assert.equal(session.gitBranch, 'main');
});

test('Claude: timestamps are captured for startedAt and endedAt', () => {
  const session = normalizeSession(claudeFixture, 'claude');
  assert.equal(session.startedAt, '2026-03-28T10:00:00.000Z');
  assert.equal(session.endedAt, '2026-03-28T10:01:10.000Z');
});

// ── Codex session tests ──────────────────────────────────────────────

test('Codex: returns session with correct sessionId and provider', () => {
  const session = normalizeSession(codexFixture, 'codex');
  assert.equal(session.sessionId, 'codex-test-session');
  assert.equal(session.provider, 'codex');
});

test('Codex: compacted entry produces type compaction', () => {
  const session = normalizeSession(codexFixture, 'codex');
  const compaction = session.messages.find((m) => m.type === 'compaction');
  assert.ok(compaction, 'should have a compaction message');
  assert.equal(compaction.role, 'system');
  assert.ok(compaction.text.includes('Summary of session'), 'text should include compaction text');
  assert.ok(
    Array.isArray(compaction.metadata.replacementHistory),
    'metadata should include replacementHistory array',
  );
  assert.deepEqual(compaction.metadata.replacementHistory, [0, 1, 2]);
});

test('Codex: empty plaintext compaction falls back to replacement_history text', () => {
  const session = normalizeSession(codexModernCompactionFixture, 'codex');
  const compaction = session.messages.find((m) => m.type === 'compaction');

  assert.ok(compaction, 'should have a compaction message');
  assert.equal(compaction.role, 'system');
  assert.ok(compaction.text.includes('replacement history fallback'), 'should include fallback note');
  assert.ok(
    compaction.text.includes('Investigate why chat.compaction_knowledge returns blank text'),
    'should include user text from replacement history',
  );
  assert.ok(
    compaction.text.includes('assistant: Codex now leaves payload.message empty'),
    'should include assistant text from replacement history',
  );
  assert.ok(compaction.text.includes('[image]'), 'should preserve image placeholders in fallback text');
  assert.equal(compaction.metadata.usedReplacementHistoryFallback, true);
  assert.equal(compaction.metadata.replacementHistory.length, 3);
});

test('Codex: developer role produces type system', () => {
  const session = normalizeSession(codexFixture, 'codex');
  const devMsg = session.messages.find((m) => m.role === 'developer');
  assert.ok(devMsg, 'should have a developer-role message');
  assert.equal(devMsg.type, 'system');
  assert.ok(devMsg.text.includes('helpful coding assistant'), 'text should include developer prompt');
});

test('Codex: user and assistant messages normalized correctly', () => {
  const session = normalizeSession(codexFixture, 'codex');
  const userMsgs = session.messages.filter((m) => m.type === 'user');
  const assistantMsgs = session.messages.filter((m) => m.type === 'assistant');

  assert.ok(userMsgs.length >= 2, 'should have at least 2 user messages');
  assert.ok(assistantMsgs.length >= 2, 'should have at least 2 assistant messages');

  for (const msg of userMsgs) {
    assert.equal(msg.role, 'user');
    assert.equal(msg.provider, 'codex');
    assert.ok(msg.text.length > 0, 'user message should have text');
  }

  for (const msg of assistantMsgs) {
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.provider, 'codex');
    assert.ok(msg.text.length > 0, 'assistant message should have text');
  }
});

test('Codex: cwd and gitBranch extracted from session_meta', () => {
  const session = normalizeSession(codexFixture, 'codex');
  assert.equal(session.cwd, '/tmp/test-repo');
  assert.equal(session.gitBranch, 'main');
});

test('Codex: message indices are sequential starting from 0', () => {
  const session = normalizeSession(codexFixture, 'codex');
  for (let i = 0; i < session.messages.length; i++) {
    assert.equal(session.messages[i].index, i, `message at position ${i} should have index ${i}`);
  }
});
