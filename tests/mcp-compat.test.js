import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INFO,
  negotiateProtocolVersion,
  createMcpRequestHandler,
} from '../src/mcp/server.js';

test('negotiateProtocolVersion echoes supported client versions', () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocolVersion(version), version);
  }
});

test('negotiateProtocolVersion falls back to newest supported version', () => {
  assert.equal(negotiateProtocolVersion('2099-01-01'), SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test('initialize negotiates protocol version and declares tool capability', async () => {
  const handleRequest = createMcpRequestHandler({
    repoPath: '.',
    claudeRoot: '.',
    codexSessionsRoot: '.',
    codexArchivedRoot: '.',
    includeArchived: true,
    defaultLimit: 20,
    defaultContextMessages: 1,
  });

  const response = await handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  });

  assert.deepEqual(response, {
    protocolVersion: '2025-06-18',
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: SERVER_INFO,
  });
});

test('ping returns an empty JSON-RPC result payload', async () => {
  const handleRequest = createMcpRequestHandler({
    repoPath: '.',
    claudeRoot: '.',
    codexSessionsRoot: '.',
    codexArchivedRoot: '.',
    includeArchived: true,
    defaultLimit: 20,
    defaultContextMessages: 1,
  });

  assert.deepEqual(
    await handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'ping',
      params: {},
    }),
    {},
  );
});
