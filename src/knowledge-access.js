import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import {
  KNOWLEDGE_DISABLED_MESSAGE,
  flattenMessages,
  getKnowledgeRoot,
  loadKnowledgeManifest,
  runKnowledgeIndex,
} from './knowledge-index.js';
import { clip, normalizeRepoPath, nowIso, scoreTextMatch, sha1 } from './utils.js';

const JOB_STATUS_TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const READ_DEFAULT_LIMIT = 200;
const READ_MAX_LIMIT = 300;
const BATCH_LIST_DEFAULT_LIMIT = 20;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const KNOWLEDGE_KIND_VALUES = new Set(['combined', 'knowledge', 'content_summary']);
const KNOWLEDGE_FILE_KIND_VALUES = new Set(['knowledge', 'content_summary']);
const jobStateById = new Map();
const activeJobIdByRepo = new Map();

class KnowledgeJobCancelledError extends Error {
  constructor(message = 'Knowledge indexing was canceled.') {
    super(message);
    this.name = 'KnowledgeJobCancelledError';
  }
}

function knowledgeEnabled(config) {
  return config.knowledge?.backend && config.knowledge.backend !== 'off';
}

function countSessionsByProvider(sessions) {
  const counts = {};
  for (const session of sessions) {
    const provider = session?.provider;
    if (!provider) continue;
    counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
}

function countMessagesByProvider(messages) {
  const counts = {};
  for (const message of messages) {
    const provider = message?.provider;
    if (!provider) continue;
    counts[provider] = (counts[provider] || 0) + 1;
  }
  return counts;
}

function getRepoJobKey(config) {
  return normalizeRepoPath(config.repoPath);
}

function getKnowledgeJobsDir(config) {
  return join(getKnowledgeRoot(config), 'jobs');
}

function getKnowledgeCombinedDir(config) {
  return join(getKnowledgeRoot(config), 'combined');
}

function getJobStatePath(config, jobId) {
  return join(getKnowledgeJobsDir(config), `${jobId}.json`);
}

function getBatchArtifactRelativePath(batchId, kind = 'combined') {
  if (kind === 'combined') {
    return join('combined', `combined-${batchId}.md`);
  }
  if (kind === 'knowledge') {
    return join('combined', `combined-${batchId}-knowledge.md`);
  }
  return join('combined', `combined-${batchId}-summary.md`);
}

function getLatestArtifactRelativePath(kind = 'combined') {
  if (kind === 'combined') {
    return join('combined', 'latest.md');
  }
  if (kind === 'knowledge') {
    return join('combined', 'latest-knowledge.md');
  }
  return join('combined', 'latest-summary.md');
}

function getBatchArtifactPath(config, batchId, kind = 'combined') {
  return join(getKnowledgeRoot(config), getBatchArtifactRelativePath(batchId, kind));
}

function getLatestArtifactPath(config, kind = 'combined') {
  return join(getKnowledgeRoot(config), getLatestArtifactRelativePath(kind));
}

function ensureKnowledgeDirectories(config) {
  mkdirSync(getKnowledgeJobsDir(config), { recursive: true });
  mkdirSync(getKnowledgeCombinedDir(config), { recursive: true });
}

function safeReadText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isTerminalStatus(status) {
  return JOB_STATUS_TERMINAL.has(status);
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function sanitizeJobState(state) {
  if (!state) return null;
  return cloneState({
    jobId: state.jobId,
    status: state.status,
    startedAt: state.startedAt,
    endedAt: state.endedAt || null,
    providerFilter: state.providerFilter ?? null,
    force: state.force === true,
    backendMode: state.backendMode || 'off',
    currentPhase: state.currentPhase || 'queued',
    batchId: state.batchId || null,
    resultStatus: state.resultStatus || null,
    messagesSeen: state.messagesSeen || 0,
    newMessages: state.newMessages || 0,
    pendingMessages: state.pendingMessages || 0,
    plannedChunkGroups: state.plannedChunkGroups || 0,
    completedChunkGroups: state.completedChunkGroups || 0,
    filesWritten: state.filesWritten || 0,
    providersIndexed: Array.isArray(state.providersIndexed) ? state.providersIndexed : [],
    sessionCountsByProvider: state.sessionCountsByProvider || {},
    messageCountsByProvider: state.messageCountsByProvider || {},
    retriedForEmptySummary: state.retriedForEmptySummary || false,
    latestCombinedFilePath: state.latestCombinedFilePath || null,
    latestKnowledgeFilePath: state.latestKnowledgeFilePath || null,
    latestContentSummaryFilePath: state.latestContentSummaryFilePath || null,
    filePaths: Array.isArray(state.filePaths) ? state.filePaths : [],
    error: state.error || null,
    message: state.message || null,
    existingJob: state.existingJob === true,
  });
}

function saveJobState(config, state) {
  ensureKnowledgeDirectories(config);
  writeFileSync(getJobStatePath(config, state.jobId), JSON.stringify(state, null, 2), 'utf8');
}

function updateJobState(entry, patch) {
  entry.state = {
    ...entry.state,
    ...patch,
  };
  saveJobState(entry.config, entry.state);
  return sanitizeJobState(entry.state);
}

function makeJobId(config, providerFilter, force) {
  const stamp = nowIso().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  const hash = sha1(
    JSON.stringify({
      repoPath: normalizeRepoPath(config.repoPath),
      providerFilter: providerFilter || null,
      force: force === true,
      createdAt: stamp,
    }),
  ).slice(0, 10);
  return `knowledge-job-${stamp}-${hash}`;
}

function normalizeReadLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return READ_DEFAULT_LIMIT;
  return Math.min(READ_MAX_LIMIT, parsed);
}

function normalizeOffset(offset) {
  const parsed = Number.parseInt(offset, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeListLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return BATCH_LIST_DEFAULT_LIMIT;
  return Math.min(200, parsed);
}

function normalizeSearchLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, parsed);
}

function normalizeKnowledgeKind(kind, { allowCombined = true } = {}) {
  if (!kind) {
    return allowCombined ? 'combined' : null;
  }

  const value = `${kind}`.trim().toLowerCase();
  if (value === 'summary') {
    return 'content_summary';
  }
  if (allowCombined && KNOWLEDGE_KIND_VALUES.has(value)) {
    return value;
  }
  if (!allowCombined && KNOWLEDGE_FILE_KIND_VALUES.has(value)) {
    return value;
  }

  const allowed = allowCombined
    ? 'combined, knowledge, or content_summary'
    : 'knowledge or content_summary';
  throw new Error(`Invalid knowledge kind "${kind}". Expected ${allowed}.`);
}

function compareRuns(left, right) {
  if ((left.chunkIndex || 0) !== (right.chunkIndex || 0)) {
    return (left.chunkIndex || 0) - (right.chunkIndex || 0);
  }
  if ((left.kind || 'knowledge') !== (right.kind || 'knowledge')) {
    return (left.kind || 'knowledge') === 'knowledge' ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

function compareBatchesNewestFirst(left, right) {
  const leftCreated = left.createdAt || '';
  const rightCreated = right.createdAt || '';
  if (leftCreated !== rightCreated) {
    return rightCreated.localeCompare(leftCreated);
  }
  return right.batchId.localeCompare(left.batchId);
}

function matchesProviderFilter(providerFilter, providersIndexed, providerHint) {
  if (!providerFilter) return true;
  if (providerHint === providerFilter) return true;
  return providersIndexed.includes(providerFilter);
}

function deriveBatchSummaries(config, manifest, providerFilter = null) {
  const grouped = new Map();

  for (const run of manifest.runs || []) {
    const batchId = run.batchId || run.id;
    if (!grouped.has(batchId)) {
      grouped.set(batchId, []);
    }
    grouped.get(batchId).push(run);
  }

  const batches = [];
  for (const [batchId, runs] of grouped.entries()) {
    const sortedRuns = [...runs].sort(compareRuns);
    const knowledgeRuns = sortedRuns.filter((run) => (run.kind || 'knowledge') === 'knowledge');
    const summaryRuns = sortedRuns.filter((run) => (run.kind || 'knowledge') === 'content_summary');
    const primaryRuns = knowledgeRuns.length > 0 ? knowledgeRuns : sortedRuns;
    const providersIndexed = [...new Set(
      primaryRuns
        .flatMap((run) => Array.isArray(run.providersIndexed) ? run.providersIndexed : Object.keys(run.messageCountsByProvider || {}))
        .filter(Boolean),
    )].sort();
    const providerHint = primaryRuns[0]?.provider ?? null;
    if (!matchesProviderFilter(providerFilter, providersIndexed, providerHint)) {
      continue;
    }

    const messageCountsByProvider = {};
    for (const run of primaryRuns) {
      for (const [provider, count] of Object.entries(run.messageCountsByProvider || {})) {
        messageCountsByProvider[provider] = (messageCountsByProvider[provider] || 0) + count;
      }
    }

    let sessionCountsByProvider = null;
    const sessionIdsByProvider = new Map();
    let allRunsHaveSessionIds = primaryRuns.length > 0;
    for (const run of primaryRuns) {
      if (Array.isArray(run.sessionRefs) && run.sessionRefs.length > 0) {
        for (const ref of run.sessionRefs) {
          const separator = `${ref}`.indexOf(':');
          if (separator <= 0) continue;
          const provider = `${ref}`.slice(0, separator);
          const sessionId = `${ref}`.slice(separator + 1);
          if (!provider || !sessionId) continue;
          if (!sessionIdsByProvider.has(provider)) {
            sessionIdsByProvider.set(provider, new Set());
          }
          sessionIdsByProvider.get(provider).add(sessionId);
        }
        continue;
      }
      if (!Array.isArray(run.sessionIds)) {
        allRunsHaveSessionIds = false;
        break;
      }
      for (const sessionId of run.sessionIds) {
        const provider = run.provider || primaryRuns[0]?.provider || null;
        if (!provider) continue;
        if (!sessionIdsByProvider.has(provider)) {
          sessionIdsByProvider.set(provider, new Set());
        }
        sessionIdsByProvider.get(provider).add(sessionId);
      }
    }
    if (allRunsHaveSessionIds) {
      sessionCountsByProvider = {};
      for (const [provider, ids] of sessionIdsByProvider.entries()) {
        sessionCountsByProvider[provider] = ids.size;
      }
    }

    const firstMessageTs = primaryRuns
      .map((run) => run.firstMessageTs || '')
      .filter(Boolean)
      .sort()[0] || null;
    const lastMessageTs = primaryRuns
      .map((run) => run.lastMessageTs || '')
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const createdAt = sortedRuns
      .map((run) => run.createdAt || '')
      .filter(Boolean)
      .sort()
      .at(-1) || null;

    batches.push({
      batchId,
      createdAt,
      backend: sortedRuns[0]?.backend || null,
      provider: providerHint,
      providersIndexed,
      sessionCountsByProvider,
      messageCountsByProvider,
      messageCount: primaryRuns.reduce((sum, run) => sum + (run.messageCount || 0), 0),
      firstMessageTs,
      lastMessageTs,
      chunkGroupCount: primaryRuns.length,
      fileCounts: {
        knowledge: knowledgeRuns.length,
        content_summary: summaryRuns.length,
      },
      model: sortedRuns[0]?.model || null,
      retriedForEmptySummary: sortedRuns.some((run) => run.retriedForEmptySummary),
      runs: sortedRuns.map((run) => ({
        id: run.id,
        groupId: run.groupId || null,
        batchId: run.batchId || null,
        chunkIndex: run.chunkIndex || null,
        batchChunkCount: run.batchChunkCount || null,
        createdAt: run.createdAt || null,
        backend: run.backend || null,
        kind: run.kind || 'knowledge',
        provider: run.provider || null,
        providersIndexed: Array.isArray(run.providersIndexed) ? run.providersIndexed : [],
        sessionCountsByProvider: run.sessionCountsByProvider || null,
        messageCountsByProvider: run.messageCountsByProvider || null,
        messageCount: run.messageCount || 0,
        firstMessageTs: run.firstMessageTs || null,
        lastMessageTs: run.lastMessageTs || null,
        chunkCount: run.chunkCount || null,
        inputChars: run.inputChars || null,
        outputChars: run.outputChars || null,
        model: run.model || null,
        retriedForEmptySummary: run.retriedForEmptySummary || false,
        filePath: join(getKnowledgeRoot(config), run.filePath),
      })),
      combinedArtifacts: {
        combinedFilePath: getBatchArtifactPath(config, batchId, 'combined'),
        knowledgeFilePath: getBatchArtifactPath(config, batchId, 'knowledge'),
        contentSummaryFilePath: getBatchArtifactPath(config, batchId, 'content_summary'),
      },
    });
  }

  return batches.sort(compareBatchesNewestFirst);
}

function renderCombinedArtifact(batch, kind) {
  const normalizedKind = normalizeKnowledgeKind(kind, { allowCombined: true });
  const includeRuns = batch.runs.filter((run) => {
    if (normalizedKind === 'combined') return true;
    return run.kind === normalizedKind;
  });

  const heading = normalizedKind === 'combined'
    ? 'Combined Repository Knowledge Batch'
    : normalizedKind === 'knowledge'
      ? 'Combined Repository Knowledge Batch (Knowledge)'
      : 'Combined Repository Knowledge Batch (Content Summary)';

  const lines = [
    `# ${heading}`,
    '',
    `Batch ID: ${batch.batchId}`,
    `Created: ${batch.createdAt || 'unknown'}`,
    `Backend: ${batch.backend || 'unknown'}`,
    `Chunk groups: ${batch.chunkGroupCount}`,
    `Messages indexed: ${batch.messageCount}`,
    '',
  ];

  if (includeRuns.length === 0) {
    lines.push('No persisted files were found for this batch and kind.');
    return `${lines.join('\n').trim()}\n`;
  }

  for (const run of includeRuns) {
    lines.push(
      `## ${run.kind === 'knowledge' ? 'Knowledge' : 'Content Summary'} Chunk ${run.chunkIndex || '?'} of ${run.batchChunkCount || '?'}`,
    );
    lines.push('');
    const body = safeReadText(run.filePath).trim() || 'Persisted file is empty.';
    lines.push(body);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function writeArtifactIfNeeded(filePath, content, force) {
  const existing = force ? null : safeReadText(filePath);
  if (!force && existing === content) {
    return;
  }
  writeFileSync(filePath, content, 'utf8');
}

function cleanupCombinedArtifacts(config, batches) {
  const combinedDir = getKnowledgeCombinedDir(config);
  if (!existsSync(combinedDir)) return;

  const referenced = new Set();
  for (const batch of batches) {
    referenced.add(batch.combinedArtifacts.combinedFilePath);
    referenced.add(batch.combinedArtifacts.knowledgeFilePath);
    referenced.add(batch.combinedArtifacts.contentSummaryFilePath);
  }
  referenced.add(getLatestArtifactPath(config, 'combined'));
  referenced.add(getLatestArtifactPath(config, 'knowledge'));
  referenced.add(getLatestArtifactPath(config, 'content_summary'));

  for (const entry of readdirSync(combinedDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolutePath = join(combinedDir, entry.name);
    if (!referenced.has(absolutePath)) {
      rmSync(absolutePath, { force: true });
    }
  }
}

export function refreshKnowledgeArtifacts(config, { force = false } = {}) {
  const manifest = loadKnowledgeManifest(config);
  const batches = deriveBatchSummaries(config, manifest, null);
  ensureKnowledgeDirectories(config);

  if (batches.length === 0) {
    for (const kind of ['combined', 'knowledge', 'content_summary']) {
      const latestPath = getLatestArtifactPath(config, kind);
      if (existsSync(latestPath)) {
        rmSync(latestPath, { force: true });
      }
    }
    cleanupCombinedArtifacts(config, batches);
    return batches;
  }

  for (const batch of batches) {
    writeArtifactIfNeeded(
      batch.combinedArtifacts.combinedFilePath,
      renderCombinedArtifact(batch, 'combined'),
      force,
    );
    writeArtifactIfNeeded(
      batch.combinedArtifacts.knowledgeFilePath,
      renderCombinedArtifact(batch, 'knowledge'),
      force,
    );
    writeArtifactIfNeeded(
      batch.combinedArtifacts.contentSummaryFilePath,
      renderCombinedArtifact(batch, 'content_summary'),
      force,
    );
  }

  const latestBatch = batches[0];
  writeArtifactIfNeeded(
    getLatestArtifactPath(config, 'combined'),
    safeReadText(latestBatch.combinedArtifacts.combinedFilePath),
    true,
  );
  writeArtifactIfNeeded(
    getLatestArtifactPath(config, 'knowledge'),
    safeReadText(latestBatch.combinedArtifacts.knowledgeFilePath),
    true,
  );
  writeArtifactIfNeeded(
    getLatestArtifactPath(config, 'content_summary'),
    safeReadText(latestBatch.combinedArtifacts.contentSummaryFilePath),
    true,
  );

  cleanupCombinedArtifacts(config, batches);
  return batches;
}

function ensureArtifactsAndBatches(config, providerFilter = null) {
  refreshKnowledgeArtifacts(config, { force: false });
  const manifest = loadKnowledgeManifest(config);
  return deriveBatchSummaries(config, manifest, providerFilter);
}

function paginateText(text, offset, limit) {
  const normalizedOffset = normalizeOffset(offset);
  const normalizedLimit = normalizeReadLimit(limit);
  const lines = `${text || ''}`.split(/\r?\n/);
  const slice = lines.slice(normalizedOffset, normalizedOffset + normalizedLimit);

  return {
    offset: normalizedOffset,
    limit: normalizedLimit,
    totalLines: lines.length,
    returnedLines: slice.length,
    hasMore: normalizedOffset + normalizedLimit < lines.length,
    text: slice.join('\n'),
  };
}

function buildReadResponse({ batchId, kind, filePath, text, offset, limit, runId = null }) {
  const page = paginateText(text, offset, limit);
  return {
    batchId,
    runId,
    kind,
    filePath,
    ...page,
  };
}

function buildEmptyReadResponse(kind, offset, limit, message) {
  return {
    status: 'empty',
    batchId: null,
    runId: null,
    kind,
    filePath: null,
    ...paginateText(message || '', offset, limit),
    message: message || 'No persisted knowledge batches were found.',
  };
}

function findBatchById(config, batchId) {
  if (!batchId) {
    throw new Error('batchId is required.');
  }

  const batches = ensureArtifactsAndBatches(config, null);
  const batch = batches.find((entry) => entry.batchId === batchId);
  if (!batch) {
    throw new Error(`Unknown knowledge batch: ${batchId}`);
  }
  return batch;
}

function getBatchFilePath(batch, kind) {
  if (kind === 'knowledge') return batch.combinedArtifacts.knowledgeFilePath;
  if (kind === 'content_summary') return batch.combinedArtifacts.contentSummaryFilePath;
  return batch.combinedArtifacts.combinedFilePath;
}

export function listKnowledgeBatches(config, params = {}) {
  const batches = ensureArtifactsAndBatches(config, params.provider || null);
  const limit = normalizeListLimit(params.limit);
  return batches.slice(0, limit).map((batch) => ({
    batchId: batch.batchId,
    createdAt: batch.createdAt,
    backend: batch.backend,
    provider: batch.provider,
    providersIndexed: batch.providersIndexed,
    sessionCountsByProvider: batch.sessionCountsByProvider,
    messageCountsByProvider: batch.messageCountsByProvider,
    messageCount: batch.messageCount,
    firstMessageTs: batch.firstMessageTs,
    lastMessageTs: batch.lastMessageTs,
    chunkGroupCount: batch.chunkGroupCount,
    fileCounts: batch.fileCounts,
    model: batch.model,
    retriedForEmptySummary: batch.retriedForEmptySummary,
    combinedArtifacts: batch.combinedArtifacts,
  }));
}

export function readLatestKnowledge(config, params = {}) {
  const kind = normalizeKnowledgeKind(params.kind, { allowCombined: true });
  const batches = ensureArtifactsAndBatches(config, null);
  if (batches.length === 0) {
    return buildEmptyReadResponse(kind, params.offset, params.limit, 'No persisted knowledge batches were found.');
  }

  const latestBatch = batches[0];
  const filePath = getBatchFilePath(latestBatch, kind);
  return buildReadResponse({
    batchId: latestBatch.batchId,
    kind,
    filePath,
    text: safeReadText(filePath),
    offset: params.offset,
    limit: params.limit,
  });
}

export function readKnowledgeBatch(config, params = {}) {
  const kind = normalizeKnowledgeKind(params.kind, { allowCombined: true });
  const batch = findBatchById(config, params.batchId);
  const filePath = getBatchFilePath(batch, kind);
  return buildReadResponse({
    batchId: batch.batchId,
    kind,
    filePath,
    text: safeReadText(filePath),
    offset: params.offset,
    limit: params.limit,
  });
}

export function listKnowledgeFiles(config, params = {}) {
  const normalizedKind = params.kind
    ? normalizeKnowledgeKind(params.kind, { allowCombined: false })
    : null;
  const batch = findBatchById(config, params.batchId);

  return batch.runs
    .filter((run) => !normalizedKind || run.kind === normalizedKind)
    .sort(compareRuns)
    .map((run) => ({
      runId: run.id,
      batchId: batch.batchId,
      groupId: run.groupId,
      chunkIndex: run.chunkIndex,
      batchChunkCount: run.batchChunkCount,
      createdAt: run.createdAt,
      backend: run.backend,
      kind: run.kind,
      provider: run.provider,
      providersIndexed: run.providersIndexed,
      sessionCountsByProvider: run.sessionCountsByProvider,
      messageCountsByProvider: run.messageCountsByProvider,
      messageCount: run.messageCount,
      firstMessageTs: run.firstMessageTs,
      lastMessageTs: run.lastMessageTs,
      inputChars: run.inputChars,
      outputChars: run.outputChars,
      filePath: run.filePath,
    }));
}

export function readKnowledgeFile(config, params = {}) {
  if (!params.runId) {
    throw new Error('runId is required.');
  }

  const manifest = loadKnowledgeManifest(config);
  const run = (manifest.runs || []).find((entry) => entry.id === params.runId);
  if (!run) {
    throw new Error(`Unknown knowledge file runId: ${params.runId}`);
  }

  const filePath = join(getKnowledgeRoot(config), run.filePath);
  return buildReadResponse({
    batchId: run.batchId || run.id,
    runId: run.id,
    kind: run.kind || 'knowledge',
    filePath,
    text: safeReadText(filePath),
    offset: params.offset,
    limit: params.limit,
  });
}

function buildSearchTargets(config, params = {}) {
  const kind = params.kind
    ? normalizeKnowledgeKind(params.kind, { allowCombined: true })
    : null;
  const batches = ensureArtifactsAndBatches(config, null);
  const filteredBatches = params.batchId
    ? batches.filter((batch) => batch.batchId === params.batchId)
    : batches;

  if (kind === 'combined') {
    return filteredBatches.map((batch) => ({
      batchId: batch.batchId,
      runId: null,
      kind: 'combined',
      filePath: batch.combinedArtifacts.combinedFilePath,
      createdAt: batch.createdAt,
    }));
  }

  return filteredBatches.flatMap((batch) =>
    batch.runs
      .filter((run) => !kind || run.kind === kind)
      .map((run) => ({
        batchId: batch.batchId,
        runId: run.id,
        kind: run.kind,
        filePath: run.filePath,
        createdAt: run.createdAt,
      })),
  );
}

export function searchKnowledge(config, params = {}) {
  if (!params.query) {
    throw new Error('query is required.');
  }

  const limit = normalizeSearchLimit(params.limit);
  const query = `${params.query}`.trim();
  const targets = buildSearchTargets(config, params);
  const matches = [];

  for (const target of targets) {
    const text = safeReadText(target.filePath);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const score = scoreTextMatch(line, query);
      if (score <= 0) continue;
      const start = Math.max(0, index - 1);
      const end = Math.min(lines.length, index + 2);
      matches.push({
        batchId: target.batchId,
        runId: target.runId,
        kind: target.kind,
        filePath: target.filePath,
        createdAt: target.createdAt || null,
        lineNumber: index + 1,
        score,
        snippet: clip(lines.slice(start, end).join('\n'), 800),
      });
    }
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftCreated = left.createdAt || '';
    const rightCreated = right.createdAt || '';
    if (leftCreated !== rightCreated) {
      return rightCreated.localeCompare(leftCreated);
    }
    if ((left.batchId || '') !== (right.batchId || '')) {
      return `${right.batchId || ''}`.localeCompare(`${left.batchId || ''}`);
    }
    return `${left.filePath}:${left.lineNumber}`.localeCompare(`${right.filePath}:${right.lineNumber}`);
  });

  return matches.slice(0, limit);
}

async function runKnowledgeJob(entry) {
  if (entry.cancelRequested || entry.state.status === 'canceled') {
    return;
  }

  updateJobState(entry, {
    status: 'running',
    currentPhase: 'starting',
    message: 'Knowledge indexing job started.',
    existingJob: false,
  });

  try {
    const result = await runKnowledgeIndex(entry.sessions, entry.config, entry.params, {
      ...entry.dependencies,
      onProgress: (patch) => {
        updateJobState(entry, patch);
      },
      isCancelled: () => entry.cancelRequested,
    });

    const batches = refreshKnowledgeArtifacts(entry.config, { force: true });
    const latestBatch = batches[0] || null;

    updateJobState(entry, {
      status: 'succeeded',
      endedAt: nowIso(),
      currentPhase: 'completed',
      resultStatus: result.status,
      batchId: result.batchId || entry.state.batchId || null,
      messagesSeen: result.messagesSeen ?? entry.state.messagesSeen,
      newMessages: result.newMessages ?? entry.state.newMessages,
      pendingMessages: result.pendingMessages ?? entry.state.pendingMessages,
      plannedChunkGroups: result.chunkCount ?? entry.state.plannedChunkGroups,
      completedChunkGroups: result.chunkCount ?? entry.state.completedChunkGroups,
      filesWritten: result.filesWritten ?? entry.state.filesWritten,
      providersIndexed: result.providersIndexed || entry.state.providersIndexed,
      sessionCountsByProvider: result.sessionCountsByProvider || entry.state.sessionCountsByProvider,
      messageCountsByProvider: result.messageCountsByProvider || entry.state.messageCountsByProvider,
      retriedForEmptySummary: result.retriedForEmptySummary || false,
      latestCombinedFilePath: latestBatch?.combinedArtifacts?.combinedFilePath || null,
      latestKnowledgeFilePath: latestBatch?.combinedArtifacts?.knowledgeFilePath || null,
      latestContentSummaryFilePath: latestBatch?.combinedArtifacts?.contentSummaryFilePath || null,
      filePaths: Array.isArray(result.filePaths) ? result.filePaths : [],
      message: result.message || 'Knowledge indexing completed.',
      existingJob: false,
    });
  } catch (err) {
    if (err instanceof KnowledgeJobCancelledError || err?.name === 'KnowledgeJobCancelledError') {
      updateJobState(entry, {
        status: 'canceled',
        endedAt: nowIso(),
        currentPhase: 'canceled',
        error: null,
        message: err.message,
        existingJob: false,
      });
      return;
    }

    updateJobState(entry, {
      status: 'failed',
      endedAt: nowIso(),
      currentPhase: 'failed',
      error: {
        type: err?.name || 'Error',
        message: err?.message || 'Unknown knowledge indexing error.',
      },
      message: `Knowledge indexing failed: ${err?.message || 'Unknown error.'}`,
      existingJob: false,
    });
  } finally {
    if (activeJobIdByRepo.get(entry.repoKey) === entry.state.jobId) {
      activeJobIdByRepo.delete(entry.repoKey);
    }
    jobStateById.set(entry.state.jobId, entry);
  }
}

function interruptStaleJobIfNeeded(config, state) {
  if (!state || isTerminalStatus(state.status)) {
    return state;
  }

  const repoKey = getRepoJobKey(config);
  const activeJobId = activeJobIdByRepo.get(repoKey);
  if (activeJobId === state.jobId) {
    return state;
  }

  const interrupted = {
    ...state,
    status: 'interrupted',
    endedAt: nowIso(),
    currentPhase: 'interrupted',
    message:
      'Knowledge indexing was interrupted before completion. Start a new job to resume indexing.',
    error: state.error || null,
  };
  saveJobState(config, interrupted);
  return interrupted;
}

export async function startKnowledgeIndex(sessions, config, params = {}, dependencies = {}) {
  if (!knowledgeEnabled(config)) {
    return {
      status: 'disabled',
      jobId: null,
      startedAt: null,
      providerFilter: params.provider || null,
      force: params.force === true,
      backendMode: config.knowledge?.backend || 'off',
      message: KNOWLEDGE_DISABLED_MESSAGE,
    };
  }

  const repoKey = getRepoJobKey(config);
  const activeJobId = activeJobIdByRepo.get(repoKey);
  if (activeJobId) {
    const activeEntry = jobStateById.get(activeJobId);
    if (activeEntry && !isTerminalStatus(activeEntry.state.status)) {
      const existing = sanitizeJobState(activeEntry.state);
      existing.existingJob = true;
      existing.message = existing.message || 'A knowledge indexing job is already running for this repository.';
      return existing;
    }
  }

  const providerFilter = params.provider || null;
  const messages = flattenMessages(sessions, { provider: providerFilter });
  const state = {
    jobId: makeJobId(config, providerFilter, params.force === true),
    status: 'queued',
    startedAt: nowIso(),
    endedAt: null,
    providerFilter,
    force: params.force === true,
    backendMode: config.knowledge?.backend || 'off',
    currentPhase: 'queued',
    batchId: null,
    resultStatus: null,
    messagesSeen: messages.length,
    newMessages: 0,
    pendingMessages: 0,
    plannedChunkGroups: 0,
    completedChunkGroups: 0,
    filesWritten: 0,
    providersIndexed: Object.keys(countMessagesByProvider(messages)).sort(),
    sessionCountsByProvider: countSessionsByProvider(sessions),
    messageCountsByProvider: countMessagesByProvider(messages),
    retriedForEmptySummary: false,
    latestCombinedFilePath: null,
    latestKnowledgeFilePath: null,
    latestContentSummaryFilePath: null,
    filePaths: [],
    error: null,
    message: 'Knowledge indexing job queued.',
    existingJob: false,
  };

  const entry = {
    repoKey,
    config,
    sessions,
    params,
    dependencies,
    cancelRequested: false,
    state,
  };

  ensureKnowledgeDirectories(config);
  saveJobState(config, state);
  jobStateById.set(state.jobId, entry);
  activeJobIdByRepo.set(repoKey, state.jobId);

  setTimeout(() => {
    void runKnowledgeJob(entry);
  }, 0);

  return sanitizeJobState(state);
}

export function getKnowledgeIndexStatus(config, params = {}) {
  if (!params.jobId) {
    throw new Error('jobId is required.');
  }

  const inMemory = jobStateById.get(params.jobId);
  if (inMemory) {
    return sanitizeJobState(inMemory.state);
  }

  const state = safeReadJson(getJobStatePath(config, params.jobId));
  if (!state) {
    throw new Error(`Unknown knowledge indexing job: ${params.jobId}`);
  }

  return sanitizeJobState(interruptStaleJobIfNeeded(config, state));
}

export function cancelKnowledgeIndex(config, params = {}) {
  if (!params.jobId) {
    throw new Error('jobId is required.');
  }

  const entry = jobStateById.get(params.jobId);
  if (entry) {
    if (isTerminalStatus(entry.state.status)) {
      return sanitizeJobState(entry.state);
    }

    entry.cancelRequested = true;
    updateJobState(entry, {
      status: entry.state.status === 'queued' ? 'canceled' : entry.state.status,
      endedAt: entry.state.status === 'queued' ? nowIso() : entry.state.endedAt,
      message: 'Knowledge indexing cancellation requested.',
      currentPhase: entry.state.status === 'queued' ? 'canceled' : 'cancel_requested',
    });
    if (entry.state.status === 'canceled' && activeJobIdByRepo.get(entry.repoKey) === params.jobId) {
      activeJobIdByRepo.delete(entry.repoKey);
    }
    return sanitizeJobState(entry.state);
  }

  const state = safeReadJson(getJobStatePath(config, params.jobId));
  if (!state) {
    throw new Error(`Unknown knowledge indexing job: ${params.jobId}`);
  }

  if (isTerminalStatus(state.status)) {
    return sanitizeJobState(state);
  }

  const interrupted = interruptStaleJobIfNeeded(config, state);
  return sanitizeJobState(interrupted);
}

export const __private = {
  deriveBatchSummaries,
  getBatchArtifactPath,
  getKnowledgeCombinedDir,
  getKnowledgeJobsDir,
  getLatestArtifactPath,
  normalizeKnowledgeKind,
  paginateText,
  refreshKnowledgeArtifacts,
  sanitizeJobState,
};
