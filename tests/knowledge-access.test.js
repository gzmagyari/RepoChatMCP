import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __private as knowledgeAccessPrivate,
  cancelKnowledgeIndex,
  getKnowledgeIndexStatus,
  listKnowledgeBatches,
  listKnowledgeFiles,
  readKnowledgeBatch,
  readKnowledgeFile,
  readLatestKnowledge,
  searchKnowledge,
  startKnowledgeIndex,
} from '../src/knowledge-access.js';
import { runKnowledgeIndex } from '../src/knowledge-index.js';

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
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'repochatmcp-access-'));
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
      text: isAssistant ? `${body}\n${'detail '.repeat(20)}` : body,
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

function summaryFor(label) {
  return {
    repositoryOverview: `Overview ${label}`,
    architectureServices: [`Architecture ${label}`],
    importantUrlsPorts: [`URL ${label}`],
    repoStructure: [`Structure ${label}`],
    implementedWork: [`Implemented ${label}`],
    rulesConstraints: [`Rule ${label}`],
    currentState: [`State ${label}`],
    openIssuesNextSteps: [`Next ${label}`],
  };
}

async function waitForTerminalStatus(config, jobId, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = getKnowledgeIndexStatus(config, { jobId });
    if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(state.status)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

test('knowledge access: start returns disabled state when indexing is off', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, { backend: 'off' });
    const result = await startKnowledgeIndex([makeSession({ count: 120 })], config, {});

    assert.equal(result.status, 'disabled');
    assert.equal(result.jobId, null);
  }));

test('knowledge access: start is async and a second start returns the existing active job', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 500000,
      httpConcurrency: 1,
    });
    const session = makeSession({ count: 120, textSize: 80 });

    const first = await startKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return summaryFor('async-start');
      },
      invokeHttpTextSummary: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'Chunk summary async-start';
      },
    });
    const second = await startKnowledgeIndex([session], config, {}, {});

    assert.equal(first.status, 'queued');
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.existingJob, true);

    const finalState = await waitForTerminalStatus(config, first.jobId);
    assert.equal(finalState.status, 'succeeded');
  }));

test('knowledge access: cancel stops a queued async indexing job', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 2500,
      httpConcurrency: 1,
    });
    const session = makeSession({ count: 120, textSize: 260 });

    const started = await startKnowledgeIndex([session], config, {}, {
      invokeHttpSummary: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return summaryFor('cancelled');
      },
      invokeHttpTextSummary: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'Chunk summary cancelled';
      },
    });
    const canceled = cancelKnowledgeIndex(config, { jobId: started.jobId });

    assert.ok(['queued', 'canceled'].includes(canceled.status));

    const finalState = await waitForTerminalStatus(config, started.jobId);
    assert.equal(finalState.status, 'canceled');
  }));

test('knowledge access: stale queued job is reported as interrupted', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, { backend: 'http', apiKey: 'test-key', model: 'test-model' });
    const jobsDir = knowledgeAccessPrivate.getKnowledgeJobsDir(config);
    fs.mkdirSync(jobsDir, { recursive: true });
    const jobId = 'knowledge-job-stale';
    fs.writeFileSync(
      path.join(jobsDir, `${jobId}.json`),
      JSON.stringify({
        jobId,
        status: 'running',
        startedAt: '2026-04-03T08:00:00.000Z',
        providerFilter: null,
        backendMode: 'http',
        currentPhase: 'summarizing_knowledge',
      }, null, 2),
      'utf8',
    );

    const state = getKnowledgeIndexStatus(config, { jobId });

    assert.equal(state.status, 'interrupted');
    assert.match(state.message, /interrupted/i);
  }));

test('knowledge access: list/read/search tools use persisted combined artifacts', async () =>
  withTempRepo(async (repoPath) => {
    const config = makeConfig(repoPath, {
      backend: 'http',
      apiKey: 'test-key',
      model: 'test-model',
      maxChars: 2500,
      httpConcurrency: 2,
    });
    const claude = makeSession({ provider: 'claude', sessionId: 'claude-1', count: 120, textSize: 260, textPrefix: 'claude auth mcp' });
    const codex = makeSession({ provider: 'codex', sessionId: 'codex-1', count: 120, textSize: 260, textPrefix: 'codex docker billing' });
    let callIndex = 0;

    const result = await runKnowledgeIndex([claude, codex], config, {}, {
      invokeHttpSummary: async () => {
        callIndex++;
        return summaryFor(`batch-${callIndex}`);
      },
      invokeHttpTextSummary: async (_prompt, _cfg, _deps) => `Content summary batch-${callIndex}\nMentions docker billing and auth.`,
    });

    assert.equal(result.status, 'indexed');

    const batches = listKnowledgeBatches(config, {});
    assert.equal(batches.length > 0, true);
    assert.equal(batches[0].batchId, result.batchId);
    assert.ok(path.isAbsolute(batches[0].combinedArtifacts.combinedFilePath));

    const latest = readLatestKnowledge(config, { kind: 'combined', offset: 0, limit: 40 });
    assert.equal(latest.batchId, result.batchId);
    assert.match(latest.text, /Combined Repository Knowledge Batch/);

    const batchRead = readKnowledgeBatch(config, {
      batchId: result.batchId,
      kind: 'knowledge',
      offset: 0,
      limit: 60,
    });
    assert.match(batchRead.text, /Repository Knowledge Summary/);

    const files = listKnowledgeFiles(config, {
      batchId: result.batchId,
      kind: 'knowledge',
    });
    assert.equal(files.length, result.chunkCount);
    assert.ok(files.every((file) => file.kind === 'knowledge'));

    const runRead = readKnowledgeFile(config, {
      runId: files[0].runId,
      offset: 0,
      limit: 40,
    });
    assert.equal(runRead.runId, files[0].runId);
    assert.match(runRead.text, /Repository Knowledge Summary/);

    const matches = searchKnowledge(config, {
      query: 'docker billing',
      kind: 'content_summary',
      limit: 5,
    });
    assert.equal(matches.length > 0, true);
    assert.ok(matches.some((match) => /docker billing/i.test(match.snippet)));
  }));
