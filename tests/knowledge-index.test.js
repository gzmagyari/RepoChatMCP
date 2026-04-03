import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KNOWLEDGE_DISABLED_MESSAGE,
  __private,
  buildBaseKnowledgeResponse,
  buildCompactionKnowledgeResponse,
  loadKnowledgeManifest,
  runKnowledgeIndex,
} from '../src/knowledge-index.js';

function makeConfig(repoPath, knowledge = {}) {
  return {
    repoPath,
    claudeRoot: repoPath,
    codexSessionsRoot: repoPath,
    codexArchivedRoot: repoPath,
    includeArchived: true,
    defaultLimit: 20,
    defaultContextMessages: 1,
    knowledge: {
      backend: 'off',
      model: null,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: null,
      maxChars: 500000,
      timeoutMs: 5000,
      codexBin: 'codex',
      httpConcurrency: 3,
      ...knowledge,
    },
  };
}

async function withTempRepo(run) {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'repochatmcp-knowledge-'));
  try {
    return await run(repoPath);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

function isoAt(index) {
  return new Date(Date.UTC(2026, 3, 2, 10, 0, index)).toISOString();
}

function makeSession({
  provider = 'claude',
  sessionId = `${provider}-session`,
  count = 120,
  textSize = 80,
  textPrefix = `${provider} message`,
} = {}) {
  const messages = [];

  for (let index = 0; index < count; index++) {
    const isAssistant = index % 2 === 1;
    const type = isAssistant ? 'assistant' : 'user';
    const role = isAssistant ? 'assistant' : 'user';
    const body = `${textPrefix} ${index} ${'x'.repeat(textSize)}`;
    messages.push({
      provider,
      sessionId,
      index,
      timestamp: isoAt(index),
      type,
      role,
      text: isAssistant ? `${body}\n${'detail '.repeat(40)}` : body,
      metadata: {},
    });
  }

  return {
    provider,
    sessionId,
    cwd: '/tmp/test-repo',
    gitBranch: 'main',
    startedAt: messages[0]?.timestamp || null,
    endedAt: messages[messages.length - 1]?.timestamp || null,
    messageCount: messages.length,
    messages,
  };
}

function makeCompactionSession({
  provider = 'codex',
  sessionId = `${provider}-compaction-session`,
  count = 4,
} = {}) {
  const messages = [];

  for (let index = 0; index < count; index++) {
    messages.push({
      provider,
      sessionId,
      index,
      timestamp: isoAt(index),
      type: 'compaction',
      role: 'system',
      text: `Summary of session ${index} with database, auth, and current state details.`,
      metadata: {},
    });
  }

  messages.push({
    provider,
    sessionId,
    index: count,
    timestamp: isoAt(count),
    type: 'assistant',
    role: 'assistant',
    text: `Long assistant fallback ${'detail '.repeat(60)}`,
    metadata: {},
  });

  return {
    provider,
    sessionId,
    cwd: '/tmp/test-repo',
    gitBranch: 'main',
    startedAt: messages[0]?.timestamp || null,
    endedAt: messages[messages.length - 1]?.timestamp || null,
    messageCount: messages.length,
    messages,
  };
}

function summaryFor(label, extraLines = 0) {
  return {
    repositoryOverview: `Overview ${label}`,
    architectureServices: [`Architecture ${label}`],
    importantUrlsPorts: [`URL ${label}`],
    repoStructure: extraLines > 0
      ? Array.from({ length: extraLines }, (_, index) => `Line ${index + 1} ${label}`)
      : [`Structure ${label}`],
    implementedWork: [`Implemented ${label}`],
    rulesConstraints: [`Rule ${label}`],
    currentState: [`State ${label}`],
    openIssuesNextSteps: [`Next ${label}`],
  };
}

test('knowledge index: disabled mode returns configuration-required response', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, { backend: 'off' });
    const session = makeSession({ count: 120 });

    const result = await runKnowledgeIndex([session], config);

    assert.equal(result.status, 'disabled');
    assert.equal(result.backend, 'off');
    assert.match(result.message, /disabled/i);
  }));

test('base knowledge: disabled mode returns persisted-only response', () =>
  withTempRepo((repoPath) => {
    const config = makeConfig(repoPath, { backend: 'off' });
    const session = makeSession({ count: 20 });

    const result = buildBaseKnowledgeResponse([session], config, {});
    const combinedText = fs.readFileSync(result.combinedKnowledgeFilePath, 'utf8');

    assert.equal(result.indexing.enabled, false);
    assert.equal(result.indexing.message, KNOWLEDGE_DISABLED_MESSAGE);
    assert.equal(result.indexedRuns.length, 0);
    assert.ok(path.isAbsolute(result.combinedKnowledgeFilePath));
    assert.equal(fs.existsSync(result.combinedKnowledgeFilePath), true);
    assert.equal(result.filePath, result.combinedKnowledgeFilePath);
    assert.equal('heuristicEntries' in result, false);
    assert.equal('heuristicsFilePath' in result, false);
    assert.match(combinedText, /No persisted indexed knowledge files were found/);
  }));

test('base knowledge: disabled mode still loads persisted knowledge runs from the manifest', () =>
  withTempRepo((repoPath) => {
    const config = makeConfig(repoPath, { backend: 'off' });
    const knowledgeRoot = path.join(repoPath, '.repochatmcp', 'knowledge');
    const runsDir = path.join(knowledgeRoot, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const relativePath = path.join('runs', 'knowledge-disabled-run.md');
    const absolutePath = path.join(knowledgeRoot, relativePath);
    fs.writeFileSync(absolutePath, '# Repository Knowledge Summary\n\nPersisted disabled-mode knowledge.\n', 'utf8');
    fs.writeFileSync(
      path.join(knowledgeRoot, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          repoPath,
          configFingerprint: 'test',
          indexedMessages: {},
          runs: [
            {
              id: 'disabled-run',
              createdAt: '2026-04-02T12:00:00.000Z',
              backend: 'http',
              provider: null,
              messageCount: 120,
              messageIds: [],
              filePath: relativePath,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = buildBaseKnowledgeResponse([makeSession({ count: 10 })], config, {});
    const combinedText = fs.readFileSync(result.combinedKnowledgeFilePath, 'utf8');

    assert.equal(result.indexing.enabled, false);
    assert.equal(result.indexedRuns.length, 1);
    assert.deepEqual(result.indexedKnowledgeFilePaths, [absolutePath]);
    assert.match(result.indexing.message, /loaded 1 persisted knowledge file/i);
    assert.match(combinedText, /Persisted disabled-mode knowledge/);
    assert.doesNotMatch(combinedText, /Live Heuristic Knowledge/);
  }));

test('compaction knowledge: returns only compaction entries and a readable file', () =>
  withTempRepo((repoPath) => {
    const config = makeConfig(repoPath, { backend: 'off' });
    const result = buildCompactionKnowledgeResponse(
      [makeCompactionSession(), makeSession({ count: 12 })],
      config,
      { limit: 10 },
    );
    const content = fs.readFileSync(result.compactionsFilePath, 'utf8');

    assert.ok(Array.isArray(result.compactionEntries));
    assert.ok(result.compactionEntries.length > 0);
    assert.ok(result.compactionEntries.every((entry) => entry.type === 'compaction'));
    assert.ok(path.isAbsolute(result.compactionsFilePath));
    assert.equal(result.filePath, result.compactionsFilePath);
    assert.match(result.message, /compactionsFilePath/);
    assert.match(content, /# Live Compaction Knowledge/);
    assert.doesNotMatch(content, /Long assistant fallback/);
  }));

test('compaction knowledge: returns a valid empty response when no compactions exist', () =>
  withTempRepo((repoPath) => {
    const config = makeConfig(repoPath, { backend: 'off' });
    const result = buildCompactionKnowledgeResponse([makeSession({ count: 12 })], config, {});
    const content = fs.readFileSync(result.compactionsFilePath, 'utf8');

    assert.deepEqual(result.compactionEntries, []);
    assert.ok(path.isAbsolute(result.compactionsFilePath));
    assert.equal(result.filePath, result.compactionsFilePath);
    assert.match(content, /No live compaction knowledge entries were found/);
  }));

test('http knowledge: parses model@provider for OpenRouter provider pinning', () => {
  assert.deepEqual(
    __private.parseProviderPinnedModel('moonshotai/kimi-k2-0905@groq'),
    {
      baseModel: 'moonshotai/kimi-k2-0905',
      provider: 'groq',
    },
  );
});

test('http knowledge: leaves model unchanged when no provider suffix is present', () => {
  assert.deepEqual(
    __private.parseProviderPinnedModel('openai/gpt-4.1-mini'),
    {
      baseModel: 'openai/gpt-4.1-mini',
      provider: null,
    },
  );
});

test('http knowledge: OpenRouter request body includes provider pinning and strips the suffix', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'moonshotai/kimi-k2-0905@groq',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    let request = null;

    const result = await __private.invokeHttpSummary('provider-pinning-prompt', config, {
      fetch: async (url, options) => {
        request = {
          url,
          options,
          body: JSON.parse(options.body),
        };
        return {
          ok: true,
          text: async () => JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(summaryFor('provider-pinned')),
                },
              },
            ],
          }),
        };
      },
    });

    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.body.model, 'moonshotai/kimi-k2-0905');
    assert.deepEqual(request.body.provider, {
      order: ['groq'],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.equal(request.body.messages[1].content, 'provider-pinning-prompt');
    assert.equal(result.repositoryOverview, 'Overview provider-pinned');
  }));

test('http knowledge: model@provider is rejected for non-OpenRouter base URLs', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'moonshotai/kimi-k2-0905@groq',
      baseUrl: 'https://api.openai.com/v1',
    });
    let called = false;

    await assert.rejects(
      __private.invokeHttpSummary('provider-pinning-prompt', config, {
        fetch: async () => {
          called = true;
          throw new Error('fetch should not be called');
        },
      }),
      /requires CHAT_SEARCH_KNOWLEDGE_BASE_URL to point to OpenRouter/i,
    );

    assert.equal(called, false);
  }));

test('http knowledge: request body stays unchanged when no provider suffix is present', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'openai/gpt-4.1-mini',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    let request = null;

    await __private.invokeHttpSummary('plain-model-prompt', config, {
      fetch: async (url, options) => {
        request = {
          url,
          options,
          body: JSON.parse(options.body),
        };
        return {
          ok: true,
          text: async () => JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(summaryFor('plain-model')),
                },
              },
            ],
          }),
        };
      },
    });

    assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.body.model, 'openai/gpt-4.1-mini');
    assert.equal('provider' in request.body, false);
  }));

test('knowledge index: chunk prompt asks for chunk-local essential knowledge rather than generic boilerplate', () => {
  const prompt = __private.buildChunkPrompt(
    [
      {
        provider: 'claude',
        sessionId: 'test-session',
        index: 0,
        timestamp: '2026-04-02T10:00:00.000Z',
        type: 'assistant',
        role: 'assistant',
        text: 'Implemented MCP setup page and added /mcp route.',
        metadata: {},
      },
    ],
    {
      repoPath: '/tmp/test-repo',
      chunkIndex: 0,
      chunkCount: 3,
    },
  );

  assert.match(prompt, /THIS chunk is mainly about/i);
  assert.match(prompt, /Do not repeat generic repo-wide boilerplate/i);
  assert.match(prompt, /URLs, ports, features, architecture details, repository structure, flows, implementation decisions/i);
});

test('knowledge index: skips when fewer than 100 new messages exist', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const session = makeSession({ count: 99 });
    let called = false;

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => {
        called = true;
        return summaryFor('should-not-run');
      },
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.pendingMessages, 99);
    assert.equal(called, false);
  }));

test('knowledge index: writes one persisted run when all pending messages fit in one chunk', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 500000,
    });
    const session = makeSession({ count: 120, textSize: 40 });
    let calls = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => {
        calls++;
        return summaryFor(`http-${calls}`);
      },
    });

    const manifest = loadKnowledgeManifest(config);

    assert.equal(result.status, 'indexed');
    assert.equal(result.backend, 'http');
    assert.equal(result.chunkCount, 1);
    assert.equal(result.filesWritten, 2);
    assert.equal(calls, 1);
    assert.equal(result.filePaths.length, 2);
    assert.deepEqual(result.providersIndexed, ['claude']);
    assert.deepEqual(result.sessionCountsByProvider, { claude: 1 });
    assert.deepEqual(result.messageCountsByProvider, { claude: 120 });
    assert.equal(manifest.runs.length, 2);
    assert.equal(Object.keys(manifest.indexedMessages).length, 120);
    assert.ok(fs.existsSync(result.filePath));
    assert.equal(result.gitignorePath, path.join(repoPath, '.gitignore'));
    assert.match(fs.readFileSync(result.gitignorePath, 'utf8'), /\.repochatmcp\//);
  }));

test('knowledge index: retries smaller HTTP chunks when a large summary comes back empty', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 500000,
    });
    const session = makeSession({ count: 120, textSize: 150 });
    let calls = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async (prompt) => {
        calls++;
        if (!prompt.includes('Partial summaries JSON:') && prompt.includes('Chunk: 1 of 1')) {
          return {};
        }
        return summaryFor(`retry-${calls}`);
      },
    });

    const storedText = fs.readFileSync(result.filePath, 'utf8');

    assert.equal(result.status, 'indexed');
    assert.equal(result.retriedForEmptySummary, true);
    assert.ok(result.chunkCount > 1);
    assert.equal(result.filesWritten, result.chunkCount * 2);
    assert.equal(result.filePaths.length, result.chunkCount * 2);
    assert.ok(calls >= 3);
    assert.match(storedText, /Overview retry-/);
  }));

test('knowledge index: creates .gitignore automatically when missing', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const session = makeSession({ count: 120 });

    assert.equal(fs.existsSync(path.join(repoPath, '.gitignore')), false);

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => summaryFor('create-gitignore'),
    });

    assert.equal(result.status, 'indexed');
    assert.equal(result.gitignorePath, path.join(repoPath, '.gitignore'));
    assert.equal(fs.existsSync(result.gitignorePath), true);
    assert.equal(fs.readFileSync(result.gitignorePath, 'utf8'), '.repochatmcp/\n');
  }));

test('knowledge index: appends .repochatmcp to existing .gitignore without duplication', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const gitignorePath = path.join(repoPath, '.gitignore');
    fs.writeFileSync(gitignorePath, '.qpanda/\n', 'utf8');
    const session = makeSession({ count: 120 });

    await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => summaryFor('append-gitignore'),
    });

    await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => summaryFor('append-gitignore-second'),
    });

    const content = fs.readFileSync(gitignorePath, 'utf8');
    const matches = content.match(/(^|\r?\n)\.repochatmcp\/(\r?\n|$)/g) || [];

    assert.match(content, /\.qpanda\//);
    assert.equal(matches.length, 1);
  }));

test('knowledge index: splits oversized input into multiple persisted knowledge files', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 3500,
    });
    const session = makeSession({ count: 120, textSize: 260 });
    let chunkCalls = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => {
        chunkCalls++;
        return summaryFor(`chunk-${chunkCalls}`);
      },
    });

    const manifest = loadKnowledgeManifest(config);
    const storedTexts = result.filePaths.map((filePath) => fs.readFileSync(filePath, 'utf8'));

    assert.equal(result.status, 'indexed');
    assert.ok(result.chunkCount > 1);
    assert.equal(result.filesWritten, result.chunkCount * 2);
    assert.equal(manifest.runs.length, result.chunkCount * 2);
    assert.equal(result.filePaths.length, result.chunkCount * 2);
    assert.ok(storedTexts.some((text) => /# Repository Knowledge Summary/.test(text)));
    assert.ok(storedTexts.some((text) => /# Repository Chunk Summary/.test(text)));
    assert.ok(chunkCalls >= 2);
  }));

test('knowledge index: adaptive split persists multiple files when the top-level HTTP summary is empty', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 3500,
    });
    const session = makeSession({ count: 120, textSize: 260 });
    let calls = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async (prompt) => {
        calls++;
        if (calls === 1) {
          return {};
        }
        return summaryFor(`chunk-${calls}`);
      },
    });

    const storedTexts = result.filePaths.map((filePath) => fs.readFileSync(filePath, 'utf8'));

    assert.equal(result.status, 'indexed');
    assert.ok(result.chunkCount > 1);
    assert.equal(result.filesWritten, result.chunkCount * 2);
    assert.ok(storedTexts.some((text) => /Overview chunk-/.test(text)));
  }));

test('knowledge index: returns real provider composition when indexing multiple providers', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 500000,
    });
    const claude = makeSession({ provider: 'claude', sessionId: 'claude-1', count: 120, textSize: 40 });
    const codex = makeSession({ provider: 'codex', sessionId: 'codex-1', count: 120, textSize: 40 });

    const result = await runKnowledgeIndex([claude, codex], config, {}, {
      invokeHttpSummary: async () => summaryFor('mixed-providers'),
    });

    const manifest = loadKnowledgeManifest(config);

    assert.deepEqual(result.providersIndexed, ['claude', 'codex']);
    assert.deepEqual(result.sessionCountsByProvider, { claude: 1, codex: 1 });
    assert.deepEqual(result.messageCountsByProvider, { claude: 120, codex: 120 });
    assert.deepEqual(manifest.runs[0].providersIndexed, ['claude', 'codex']);
    assert.deepEqual(manifest.runs[0].sessionCountsByProvider, { claude: 1, codex: 1 });
    assert.deepEqual(manifest.runs[0].messageCountsByProvider, { claude: 120, codex: 120 });
  }));

test('knowledge index: codex chunk execution is strictly sequential', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'codex',
      maxChars: 3500,
    });
    const session = makeSession({ count: 120, textSize: 260 });
    let active = 0;
    let maxActive = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      detectCodexBackend: async () => ({ available: true, loggedIn: true, version: 'codex-test' }),
      invokeCodexSummary: async (prompt) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return prompt.includes('Partial summaries JSON:')
          ? summaryFor('codex-merge')
          : summaryFor('codex-chunk');
      },
    });

    assert.equal(result.status, 'indexed');
    assert.equal(result.backend, 'codex');
    assert.equal(maxActive, 1);
    assert.ok(result.chunkCount > 1);
  }));

test('knowledge index: http chunk execution is capped at concurrency 3', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 2500,
      httpConcurrency: 3,
    });
    const session = makeSession({ count: 140, textSize: 260 });
    let active = 0;
    let maxActive = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async (prompt) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return prompt.includes('Partial summaries JSON:')
          ? summaryFor('http-merge')
          : summaryFor('http-chunk');
      },
    });

    assert.equal(result.status, 'indexed');
    assert.equal(result.backend, 'http');
    assert.ok(result.chunkCount > 1);
    assert.ok(maxActive <= 3);
  }));

test('knowledge index: unchanged messages stay cached but changed messages re-enqueue the invalidated run', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const session = makeSession({ count: 120, textSize: 60 });
    let callCount = 0;

    const dependencies = {
      invokeHttpSummary: async () => {
        callCount++;
        return summaryFor(`run-${callCount}`);
      },
    };

    const first = await runKnowledgeIndex([session], config, {}, dependencies);
    const second = await runKnowledgeIndex([session], config, {}, dependencies);

    session.messages[10].text = `${session.messages[10].text}\nchanged`;

    const third = await runKnowledgeIndex([session], config, {}, dependencies);
    const manifest = loadKnowledgeManifest(config);

    assert.equal(first.status, 'indexed');
    assert.equal(second.status, 'skipped');
    assert.equal(second.pendingMessages, 0);
    assert.equal(third.status, 'indexed');
    assert.equal(third.newMessages, 120);
    assert.equal(manifest.runs.length, 2);
  }));

test('knowledge index: force rebuild removes the previous persisted run file', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const session = makeSession({ count: 120, textSize: 60 });

    const first = await runKnowledgeIndex([session], config, {}, {
      now: () => '2026-04-02T20:00:00.000Z',
      invokeHttpSummary: async () => summaryFor('first'),
    });

    const firstPath = first.filePath;
    assert.equal(fs.existsSync(firstPath), true);

    const second = await runKnowledgeIndex([session], config, { force: true }, {
      now: () => '2026-04-02T20:10:00.000Z',
      invokeHttpSummary: async () => summaryFor('second'),
    });

    const manifest = loadKnowledgeManifest(config);

    assert.equal(second.status, 'indexed');
    assert.equal(fs.existsSync(second.filePath), true);
    assert.equal(fs.existsSync(firstPath), false);
    assert.equal(manifest.runs.length, 2);
    assert.equal(manifest.runs[0].batchId, second.batchId);
  }));

test('knowledge index: removes orphaned run files that are not referenced by the manifest', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const session = makeSession({ count: 120, textSize: 60 });
    const runsDir = path.join(repoPath, '.repochatmcp', 'knowledge', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const orphanPath = path.join(runsDir, 'knowledge-orphan.md');
    fs.writeFileSync(orphanPath, '# Orphaned knowledge\n', 'utf8');

    const result = await runKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => summaryFor('active'),
    });

    assert.equal(result.status, 'indexed');
    assert.equal(fs.existsSync(orphanPath), false);
    assert.equal(fs.existsSync(result.filePath), true);
  }));

test('knowledge index: auto mode prefers http when API config is present', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'auto',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const session = makeSession({ count: 120 });
    let httpCalls = 0;
    let codexCalls = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      detectCodexBackend: async () => ({ available: true, loggedIn: true, version: 'codex-test' }),
      invokeHttpSummary: async () => {
        httpCalls++;
        return summaryFor('http');
      },
      invokeCodexSummary: async () => {
        codexCalls++;
        return summaryFor('codex');
      },
    });

    assert.equal(result.backend, 'http');
    assert.equal(httpCalls, 1);
    assert.equal(codexCalls, 0);
  }));

test('knowledge index: auto mode falls back to codex when HTTP config is absent', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, { backend: 'auto' });
    const session = makeSession({ count: 120 });
    let codexCalls = 0;

    const result = await runKnowledgeIndex([session], config, {}, {
      detectCodexBackend: async () => ({ available: true, loggedIn: true, version: 'codex-test' }),
      invokeCodexSummary: async () => {
        codexCalls++;
        return summaryFor('codex');
      },
    });

    assert.equal(result.backend, 'codex');
    assert.equal(codexCalls, 1);
  }));

test('knowledge index: http mode errors clearly when required config is missing', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, { backend: 'http', apiKey: null, model: null });
    const session = makeSession({ count: 120 });

    await assert.rejects(
      runKnowledgeIndex([session], config),
      /CHAT_SEARCH_KNOWLEDGE_API_KEY and CHAT_SEARCH_KNOWLEDGE_MODEL/,
    );
  }));

test('knowledge index: codex mode errors clearly when Codex is unavailable', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, { backend: 'codex' });
    const session = makeSession({ count: 120 });

    await assert.rejects(
      runKnowledgeIndex([session], config, {}, {
        detectCodexBackend: async () => ({
          available: false,
          loggedIn: false,
          reason: 'Codex CLI is not available.',
        }),
      }),
      /Codex CLI is not available/,
    );
  }));

test('base knowledge: includes persisted summaries when indexing is enabled and tails to newest 1000 lines', () =>
  withTempRepo((repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const knowledgeRoot = path.join(repoPath, '.repochatmcp', 'knowledge');
    const runsDir = path.join(knowledgeRoot, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    const relativePath = path.join('runs', 'knowledge-test-run.md');
    const absolutePath = path.join(knowledgeRoot, relativePath);
    const hugeContent = Array.from({ length: 1205 }, (_, index) => `Persisted line ${index + 1}`).join('\n');
    fs.writeFileSync(absolutePath, hugeContent, 'utf8');
    fs.writeFileSync(
      path.join(knowledgeRoot, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          repoPath,
          configFingerprint: 'test',
          indexedMessages: {},
          runs: [
            {
              id: 'test-run',
              createdAt: '2026-04-02T12:00:00.000Z',
              backend: 'http',
              provider: null,
              messageCount: 120,
              messageIds: [],
              filePath: relativePath,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = buildBaseKnowledgeResponse([makeSession({ count: 10 })], config, {});
    const combinedText = fs.readFileSync(result.combinedKnowledgeFilePath, 'utf8');

    assert.equal(result.indexing.enabled, true);
    assert.equal(result.indexedRuns.length, 1);
    assert.deepEqual(result.indexedKnowledgeFilePaths, [absolutePath]);
    assert.equal(result.indexedRuns[0].filePath, absolutePath);
    assert.equal('messageIds' in result.indexedRuns[0], false);
    assert.match(combinedText, /Persisted line 1/);
    assert.doesNotMatch(combinedText, /Live Heuristic Knowledge/);
    assert.equal(result.truncated, true);
    assert.ok(path.isAbsolute(result.combinedKnowledgeFilePath));
    assert.equal('heuristicEntries' in result, false);
    assert.equal('heuristicsFilePath' in result, false);
    assert.match(result.message, /stored in files/i);
  }));
