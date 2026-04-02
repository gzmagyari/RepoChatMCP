import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverSessionFiles } from '../src/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function encodeClaudeProjectDir(repoPath) {
  let p = repoPath.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + '-' + p.slice(2);
  }
  return p.replace(/\//g, '-');
}

test('discoverSessionFiles: deduplicates Claude sessions on Windows case-insensitive paths', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only regression test');
    return;
  }

  const repoPath = 'C:\\xampp\\htdocs\\RepoChatMCP';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-search-discovery-'));
  const claudeRoot = path.join(tmpRoot, 'claude-projects');
  const projectDir = path.join(claudeRoot, encodeClaudeProjectDir(repoPath));

  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(
    path.join(fixturesDir, 'claude-session.jsonl'),
    path.join(projectDir, 'claude-test-session.jsonl'),
  );

  t.after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const sessionFiles = discoverSessionFiles({
    repoPath,
    claudeRoot,
    codexSessionsRoot: path.join(tmpRoot, 'codex-sessions'),
    codexArchivedRoot: path.join(tmpRoot, 'codex-archived'),
    includeArchived: true,
  });

  const claudeSessions = sessionFiles.filter((file) => file.provider === 'claude');
  assert.equal(claudeSessions.length, 1);
  assert.ok(claudeSessions[0].filePath.endsWith('claude-test-session.jsonl'));
});
