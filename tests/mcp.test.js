import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');
const binScript = path.join(__dirname, '..', 'bin', 'chat-search.js');

/**
 * Set up a temp directory with fixtures in the right structure for discovery.
 * Claude: <tmpdir>/claude-projects/tmp-test-repo/<file>.jsonl
 * Codex:  <tmpdir>/codex-sessions/2026/03/28/<file>.jsonl
 */
function setupTempFixtures() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-search-test-'));

  // Claude project dir — discovery encodes /tmp/test-repo as -tmp-test-repo
  const claudeProjectDir = path.join(tmpRoot, 'claude-projects', '-tmp-test-repo');
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  fs.copyFileSync(
    path.join(fixturesDir, 'claude-session.jsonl'),
    path.join(claudeProjectDir, 'claude-test-session.jsonl'),
  );

  // Codex session dir
  const codexSessionDir = path.join(tmpRoot, 'codex-sessions', '2026', '03', '28');
  fs.mkdirSync(codexSessionDir, { recursive: true });
  fs.copyFileSync(
    path.join(fixturesDir, 'codex-session.jsonl'),
    path.join(codexSessionDir, 'codex-test-session.jsonl'),
  );

  return {
    tmpRoot,
    claudeRoot: path.join(tmpRoot, 'claude-projects'),
    codexSessions: path.join(tmpRoot, 'codex-sessions'),
    cleanup() {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function readJsonLineResponse(proc) {
  return new Promise((resolve, reject) => {
    let responseBuffer = '';

    function onData(chunk) {
      responseBuffer += chunk.toString('utf8');
      const newlineIndex = responseBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const responseBody = responseBuffer.slice(0, newlineIndex).trim();
      proc.stdout.removeListener('data', onData);
      try {
        resolve(JSON.parse(responseBody));
      } catch (err) {
        reject(new Error(`Invalid JSON response: ${err.message}`));
      }
    }

    proc.stdout.on('data', onData);
  });
}

/**
 * Send a JSON-RPC message as a single JSON line and read the JSON line response.
 */
function sendRpc(proc, message) {
  const response = readJsonLineResponse(proc);
  proc.stdin.write(`${JSON.stringify(message)}\n`);
  return response;
}

/**
 * Send a legacy Content-Length framed JSON-RPC message and read the framed response.
 */
function sendFramedRpc(proc, message) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = `Content-Length: ${body.length}\r\n\r\n`;

    let responseBuffer = Buffer.alloc(0);
    let expectedLength = null;

    function onData(chunk) {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);

      while (true) {
        if (expectedLength === null) {
          const headerEnd = responseBuffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const headerText = responseBuffer.slice(0, headerEnd).toString('utf8');
          const match = headerText.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            reject(new Error('Missing Content-Length in response'));
            return;
          }
          expectedLength = Number(match[1]);
          responseBuffer = responseBuffer.slice(headerEnd + 4);
        }

        if (responseBuffer.length < expectedLength) return;

        const responseBody = responseBuffer.slice(0, expectedLength).toString('utf8');
        proc.stdout.removeListener('data', onData);
        try {
          resolve(JSON.parse(responseBody));
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${err.message}`));
        }
        return;
      }
    }

    proc.stdout.on('data', onData);
    proc.stdin.write(header);
    proc.stdin.write(body);
  });
}

/**
 * Spawn the MCP server process.
 */
function spawnMcp(fixtures) {
  const args = [
    binScript,
    '--repo', '/tmp/test-repo',
    '--claude-root', fixtures.claudeRoot,
    '--codex-sessions', fixtures.codexSessions,
  ];

  const proc = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  return proc;
}

test('MCP: initialize returns valid server info', async () => {
  const fixtures = setupTempFixtures();
  const proc = spawnMcp(fixtures);

  try {
    const response = await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.ok(response.result, 'should have result');
    assert.equal(response.result.protocolVersion, '2024-11-05');
    assert.ok(response.result.serverInfo, 'should have serverInfo');
    assert.equal(response.result.serverInfo.name, 'chat-search');
  } finally {
    proc.kill();
    fixtures.cleanup();
  }
});

test('MCP: initialize also works with legacy Content-Length framing', async () => {
  const fixtures = setupTempFixtures();
  const proc = spawnMcp(fixtures);

  try {
    const response = await sendFramedRpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2024-11-05');
    assert.equal(response.result.serverInfo.name, 'chat-search');
  } finally {
    proc.kill();
    fixtures.cleanup();
  }
});

test('MCP: tools/list returns 7 tools with correct names', async () => {
  const fixtures = setupTempFixtures();
  const proc = spawnMcp(fixtures);

  try {
    // Must initialize first
    await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const response = await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 2);
    assert.ok(response.result, 'should have result');
    assert.ok(response.result.tools, 'should have tools array');
    assert.equal(response.result.tools.length, 7, 'should have exactly 7 tools');

    const toolNames = response.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'chat.base_knowledge',
      'chat.grep',
      'chat.knowledge_index',
      'chat.list_sessions',
      'chat.read_lines',
      'chat.read_session',
      'chat.search',
    ]);
  } finally {
    proc.kill();
    fixtures.cleanup();
  }
});

test('MCP: tools/call chat.list_sessions returns session data', async () => {
  const fixtures = setupTempFixtures();
  const proc = spawnMcp(fixtures);

  try {
    await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const response = await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'chat.list_sessions',
        arguments: {},
      },
    });

    assert.equal(response.id, 2);
    assert.ok(response.result, 'should have result');
    assert.ok(response.result.content, 'should have content');
    assert.equal(response.result.content[0].type, 'text');

    const data = JSON.parse(response.result.content[0].text);
    assert.ok(Array.isArray(data), 'result should be an array');
    // Should find at least the Claude session (Codex may not match due to discovery filtering)
    assert.ok(data.length >= 1, 'should find at least one session');
    const sessionIds = data.map((s) => s.sessionId);
    assert.ok(
      sessionIds.includes('claude-test-session'),
      'should include the Claude test session',
    );
  } finally {
    proc.kill();
    fixtures.cleanup();
  }
});

test('MCP: knowledge tools return disabled indexing state by default', async () => {
  const fixtures = setupTempFixtures();
  const proc = spawnMcp(fixtures);

  try {
    await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const baseKnowledge = await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'chat.base_knowledge',
        arguments: {},
      },
    });

    const indexKnowledge = await sendRpc(proc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'chat.knowledge_index',
        arguments: {},
      },
    });

    const baseData = JSON.parse(baseKnowledge.result.content[0].text);
    const indexData = JSON.parse(indexKnowledge.result.content[0].text);

    assert.equal(baseData.indexing.enabled, false);
    assert.ok(Array.isArray(baseData.heuristicEntries));
    assert.ok(path.isAbsolute(baseData.heuristicsFilePath));
    assert.ok(path.isAbsolute(baseData.combinedKnowledgeFilePath));
    assert.equal(typeof baseData.message, 'string');
    assert.equal(indexData.status, 'disabled');
  } finally {
    proc.kill();
    fixtures.cleanup();
  }
});
