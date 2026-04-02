import { spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectCompactionKnowledge,
  renderCompactionKnowledge,
  writeKnowledgeTextToFile,
} from './knowledge.js';
import { clip, normalizeRepoPath, nowIso, sha1 } from './utils.js';

export const KNOWLEDGE_DISABLED_MESSAGE =
  'Knowledge indexing is disabled. Set CHAT_SEARCH_KNOWLEDGE_BACKEND to auto, http, or codex in the MCP server env to enable it.';
export const MIN_INDEXABLE_MESSAGES = 100;
export const MAX_COMBINED_KNOWLEDGE_LINES = 1000;

const KNOWLEDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'repositoryOverview',
    'architectureServices',
    'importantUrlsPorts',
    'repoStructure',
    'implementedWork',
    'rulesConstraints',
    'currentState',
    'openIssuesNextSteps',
  ],
  properties: {
    repositoryOverview: { type: 'string' },
    architectureServices: { type: 'array', items: { type: 'string' } },
    importantUrlsPorts: { type: 'array', items: { type: 'string' } },
    repoStructure: { type: 'array', items: { type: 'string' } },
    implementedWork: { type: 'array', items: { type: 'string' } },
    rulesConstraints: { type: 'array', items: { type: 'string' } },
    currentState: { type: 'array', items: { type: 'string' } },
    openIssuesNextSteps: { type: 'array', items: { type: 'string' } },
  },
};

function knowledgeEnabled(config) {
  return config.knowledge?.backend && config.knowledge.backend !== 'off';
}

export function getKnowledgeRoot(config) {
  return join(config.repoPath, '.repochatmcp', 'knowledge');
}

function getKnowledgeRunsDir(config) {
  return join(getKnowledgeRoot(config), 'runs');
}

function getKnowledgeManifestPath(config) {
  return join(getKnowledgeRoot(config), 'manifest.json');
}

function getGitignorePath(config) {
  return join(config.repoPath, '.gitignore');
}

function emptyManifest(config) {
  return {
    version: 1,
    repoPath: normalizeRepoPath(config.repoPath),
    configFingerprint: null,
    indexedMessages: {},
    runs: [],
  };
}

export function loadKnowledgeManifest(config) {
  const manifestPath = getKnowledgeManifestPath(config);
  if (!existsSync(manifestPath)) {
    return emptyManifest(config);
  }

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return {
      version: parsed.version || 1,
      repoPath: parsed.repoPath || normalizeRepoPath(config.repoPath),
      configFingerprint: parsed.configFingerprint || null,
      indexedMessages: parsed.indexedMessages || {},
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return emptyManifest(config);
  }
}

function saveKnowledgeManifest(config, manifest) {
  const root = getKnowledgeRoot(config);
  mkdirSync(root, { recursive: true });
  writeFileSync(getKnowledgeManifestPath(config), JSON.stringify(manifest, null, 2), 'utf8');
}

function gitignoreAlreadyCoversKnowledge(content) {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  return lines.some((line) =>
    line === '.repochatmcp' ||
    line === '.repochatmcp/' ||
    line === '/.repochatmcp' ||
    line === '/.repochatmcp/',
  );
}

function ensureKnowledgeGitignore(config) {
  const gitignorePath = getGitignorePath(config);
  const currentContent = readTextIfExists(gitignorePath);

  if (gitignoreAlreadyCoversKnowledge(currentContent)) {
    return gitignorePath;
  }

  const nextContent = currentContent
    ? `${currentContent.replace(/\s*$/, '')}\n.repochatmcp/\n`
    : '.repochatmcp/\n';

  writeFileSync(gitignorePath, nextContent, 'utf8');
  return gitignorePath;
}

function cloneManifest(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

function configFingerprint(config) {
  return sha1(
    JSON.stringify({
      backend: config.knowledge?.backend || 'off',
      model: config.knowledge?.model || null,
      baseUrl: config.knowledge?.baseUrl || null,
      maxChars: config.knowledge?.maxChars || null,
      timeoutMs: config.knowledge?.timeoutMs || null,
      httpConcurrency: config.knowledge?.httpConcurrency || null,
    }),
  );
}

export function getMessageCacheKey(message) {
  return `${message.provider}:${message.sessionId}:${message.index}`;
}

export function getMessageCacheHash(message) {
  return sha1(
    JSON.stringify({
      timestamp: message.timestamp || null,
      type: message.type || null,
      role: message.role || null,
      text: message.text || '',
      metadata: message.metadata || {},
    }),
  );
}

export function flattenMessages(sessions, { provider } = {}) {
  const messages = [];

  for (const session of sessions) {
    if (provider && session.provider !== provider) continue;

    for (const message of session.messages || []) {
      messages.push(message);
    }
  }

  messages.sort((left, right) => {
    const leftTime = left.timestamp || '';
    const rightTime = right.timestamp || '';
    if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
    if (left.provider !== right.provider) return left.provider.localeCompare(right.provider);
    if (left.sessionId !== right.sessionId) return left.sessionId.localeCompare(right.sessionId);
    return left.index - right.index;
  });

  return messages;
}

function serializeMessage(message) {
  return [
    `message_id: ${getMessageCacheKey(message)}`,
    `timestamp: ${message.timestamp || 'unknown'}`,
    `provider: ${message.provider}`,
    `session_id: ${message.sessionId}`,
    `type: ${message.type}`,
    `role: ${message.role || 'unknown'}`,
    'text:',
    message.text || '',
  ].join('\n');
}

export function serializeTranscript(messages) {
  return messages
    .map((message) => serializeMessage(message))
    .join('\n\n===== MESSAGE =====\n\n');
}

export function splitMessagesByChars(messages, maxChars) {
  if (messages.length === 0) return [];

  const chunks = [];
  let currentMessages = [];
  let currentChars = 0;

  for (const message of messages) {
    const serialized = serializeMessage(message);
    const addition = (currentMessages.length > 0 ? '\n\n===== MESSAGE =====\n\n'.length : 0) + serialized.length;

    if (currentMessages.length > 0 && currentChars + addition > maxChars) {
      chunks.push(currentMessages);
      currentMessages = [message];
      currentChars = serialized.length;
      continue;
    }

    currentMessages.push(message);
    currentChars += addition;
  }

  if (currentMessages.length > 0) {
    chunks.push(currentMessages);
  }

  return chunks;
}

function buildChunkPrompt(messages, { repoPath, chunkIndex, chunkCount }) {
  return [
    'You are extracting durable repository knowledge from chat transcripts.',
    'Focus only on repository-relevant facts that future coding agents need.',
    'Ignore chatter, repeated retries, and noisy logs unless they reveal an important constraint.',
    'Return JSON only. Keep every bullet short and high signal.',
    '',
    `Repository path: ${repoPath}`,
    `Chunk: ${chunkIndex + 1} of ${chunkCount}`,
    '',
    'JSON schema fields:',
    '- repositoryOverview: one concise paragraph string',
    '- architectureServices: short bullet strings',
    '- importantUrlsPorts: short bullet strings',
    '- repoStructure: short bullet strings',
    '- implementedWork: short bullet strings',
    '- rulesConstraints: short bullet strings',
    '- currentState: short bullet strings',
    '- openIssuesNextSteps: short bullet strings',
    '',
    'Transcript:',
    serializeTranscript(messages),
  ].join('\n');
}

function buildMergePrompt(summaries, { repoPath }) {
  return [
    'You are merging partial repository knowledge summaries into one final repository memory.',
    'Deduplicate aggressively and keep only durable, high-signal information.',
    'Return JSON only and preserve the same schema.',
    '',
    `Repository path: ${repoPath}`,
    '',
    'Partial summaries JSON:',
    JSON.stringify(summaries, null, 2),
  ].join('\n');
}

function parseJsonResponse(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Continue into fence/object extraction.
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch {
      // Continue.
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeSummary(summary) {
  const normalized = summary || {};
  const asArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value.map((item) => `${item}`.trim()).filter(Boolean);
    return `${value}`
      .split(/\r?\n/)
      .map((item) => item.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  };

  return {
    repositoryOverview: `${normalized.repositoryOverview || ''}`.trim(),
    architectureServices: asArray(normalized.architectureServices),
    importantUrlsPorts: asArray(normalized.importantUrlsPorts),
    repoStructure: asArray(normalized.repoStructure),
    implementedWork: asArray(normalized.implementedWork),
    rulesConstraints: asArray(normalized.rulesConstraints),
    currentState: asArray(normalized.currentState),
    openIssuesNextSteps: asArray(normalized.openIssuesNextSteps),
  };
}

function summaryHasContent(summary) {
  const normalized = normalizeSummary(summary);
  if (normalized.repositoryOverview) return true;

  return [
    normalized.architectureServices,
    normalized.importantUrlsPorts,
    normalized.repoStructure,
    normalized.implementedWork,
    normalized.rulesConstraints,
    normalized.currentState,
    normalized.openIssuesNextSteps,
  ].some((items) => items.length > 0);
}

function mergeUniqueItems(...groups) {
  return [...new Set(groups.flat().map((item) => `${item}`.trim()).filter(Boolean))];
}

function mergeSummariesDeterministically(summaries) {
  const normalized = summaries.map((summary) => normalizeSummary(summary)).filter(summaryHasContent);
  if (normalized.length === 0) {
    return normalizeSummary({});
  }

  return {
    repositoryOverview: normalized
      .map((summary) => summary.repositoryOverview)
      .filter(Boolean)
      .join('\n\n'),
    architectureServices: mergeUniqueItems(...normalized.map((summary) => summary.architectureServices)),
    importantUrlsPorts: mergeUniqueItems(...normalized.map((summary) => summary.importantUrlsPorts)),
    repoStructure: mergeUniqueItems(...normalized.map((summary) => summary.repoStructure)),
    implementedWork: mergeUniqueItems(...normalized.map((summary) => summary.implementedWork)),
    rulesConstraints: mergeUniqueItems(...normalized.map((summary) => summary.rulesConstraints)),
    currentState: mergeUniqueItems(...normalized.map((summary) => summary.currentState)),
    openIssuesNextSteps: mergeUniqueItems(...normalized.map((summary) => summary.openIssuesNextSteps)),
  };
}

function renderSection(lines, heading, items) {
  if (!items || items.length === 0) return;
  lines.push(`## ${heading}`);
  lines.push('');
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push('');
}

export function renderKnowledgeSummary(summary, metadata = {}) {
  const normalized = normalizeSummary(summary);
  const lines = ['# Repository Knowledge Summary', ''];

  if (metadata.runId) {
    lines.push(`Run ID: ${metadata.runId}`);
  }
  if (metadata.createdAt) {
    lines.push(`Created: ${metadata.createdAt}`);
  }
  if (metadata.backend) {
    lines.push(`Backend: ${metadata.backend}`);
  }
  if (metadata.messageCount !== undefined) {
    lines.push(`Messages indexed: ${metadata.messageCount}`);
  }
  if (metadata.chunkCount !== undefined) {
    lines.push(`Chunk count: ${metadata.chunkCount}`);
  }
  if (lines.length > 2) {
    lines.push('');
  }

  lines.push('## Repository Overview');
  lines.push('');
  lines.push(normalized.repositoryOverview || 'No overview extracted.');
  lines.push('');

  renderSection(lines, 'Architecture And Services', normalized.architectureServices);
  renderSection(lines, 'Important URLs And Ports', normalized.importantUrlsPorts);
  renderSection(lines, 'Repository Structure', normalized.repoStructure);
  renderSection(lines, 'Implemented Work', normalized.implementedWork);
  renderSection(lines, 'Rules And Constraints', normalized.rulesConstraints);
  renderSection(lines, 'Current State', normalized.currentState);
  renderSection(lines, 'Open Issues And Next Steps', normalized.openIssuesNextSteps);

  return `${lines.join('\n').trim()}\n`;
}

function buildKnowledgeRunId(messages, timestamp) {
  const firstId = messages[0] ? getMessageCacheKey(messages[0]) : 'empty';
  const lastId = messages[messages.length - 1] ? getMessageCacheKey(messages[messages.length - 1]) : 'empty';
  const compactTimestamp = timestamp.replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
  return `${compactTimestamp}-${sha1(`${firstId}:${lastId}:${messages.length}`).slice(0, 10)}`;
}

function relativeRunPath(runId) {
  return join('runs', `knowledge-${runId}.md`);
}

function readTextIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(filePath) {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

function cleanupUnreferencedRunFiles(config, activeRuns) {
  const runsDir = getKnowledgeRunsDir(config);
  if (!fileExists(runsDir)) return;

  const referenced = new Set(activeRuns.map((run) => join(getKnowledgeRoot(config), run.filePath)));

  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^knowledge-.*\.md$/i.test(entry.name)) continue;

    const absolutePath = join(runsDir, entry.name);
    if (!referenced.has(absolutePath) && fileExists(absolutePath)) {
      rmSync(absolutePath, { force: true });
    }
  }
}

async function runCommandCapture(command, args, { cwd, env, input, timeoutMs = 30000 } = {}) {
  return await new Promise((resolve, reject) => {
    const resolvedCommand =
      process.platform === 'win32' && !/[\\/]/.test(command) && !/\.[a-z0-9]+$/i.test(command)
        ? `${command}.cmd`
        : command;
    const isWindows = process.platform === 'win32';
    const winEscapeArg = (value) => `"${`${value}`.replace(/"/g, '\\"')}"`;
    const child = spawn(
      isWindows
        ? [`"${resolvedCommand}"`, ...args.map(winEscapeArg)].join(' ')
        : resolvedCommand,
      isWindows ? [] : args,
      {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: isWindows,
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const killChild = () => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', `${child.pid}`, '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore kill failures.
        }
      }
    };

    const timer = setTimeout(() => {
      killChild();
      finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      finish(() => resolve({ code, stdout, stderr }));
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

export async function detectCodexBackend(config, dependencies = {}) {
  const runCommand = dependencies.runCommand || runCommandCapture;
  const command = config.knowledge?.codexBin || 'codex';

  const version = await runCommand(command, ['--version'], {
    cwd: config.repoPath,
    timeoutMs: Math.min(config.knowledge?.timeoutMs || 30000, 30000),
  }).catch(() => null);

  if (!version || version.code !== 0) {
    return {
      available: false,
      loggedIn: false,
      command,
      reason: 'Codex CLI is not available.',
    };
  }

  const login = await runCommand(command, ['login', 'status'], {
    cwd: config.repoPath,
    timeoutMs: Math.min(config.knowledge?.timeoutMs || 30000, 30000),
  }).catch(() => null);

  if (!login || login.code !== 0) {
    return {
      available: true,
      loggedIn: false,
      command,
      reason: 'Codex CLI is not authenticated. Run `codex login` first.',
    };
  }

  return {
    available: true,
    loggedIn: true,
    command,
    version: version.stdout.trim(),
  };
}

function getHttpEndpoint(baseUrl) {
  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return root.endsWith('/chat/completions') ? root : `${root}/chat/completions`;
}

function isOpenRouterBaseUrl(baseUrl) {
  try {
    const resolved = new URL(baseUrl || 'https://api.openai.com/v1');
    return resolved.hostname === 'openrouter.ai' || resolved.hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

function parseProviderPinnedModel(model) {
  const value = `${model || ''}`.trim();
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    return {
      baseModel: value,
      provider: null,
    };
  }

  return {
    baseModel: value.slice(0, separator),
    provider: value.slice(separator + 1),
  };
}

async function invokeHttpSummary(prompt, config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('Global fetch is not available for HTTP knowledge indexing.');
  }

  const endpoint = getHttpEndpoint(config.knowledge.baseUrl);
  const { baseModel, provider } = parseProviderPinnedModel(config.knowledge.model);
  if (provider && !isOpenRouterBaseUrl(config.knowledge.baseUrl)) {
    throw new Error(
      'OpenRouter provider pinning via "@provider" requires CHAT_SEARCH_KNOWLEDGE_BASE_URL to point to OpenRouter.',
    );
  }

  const timeoutMs = config.knowledge.timeoutMs || 120000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody = {
      model: baseModel,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You extract durable repository knowledge from coding chat logs. Return JSON only and keep it concise.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: { type: 'json_object' },
    };

    if (provider) {
      requestBody.provider = {
        order: [provider],
        allow_fallbacks: false,
        require_parameters: true,
      };
    }

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.knowledge.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP knowledge request failed (${response.status}): ${clip(raw, 500)}`);
    }

    const parsed = JSON.parse(raw);
    const content = parsed?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((item) => item?.text || '').join('\n')
      : `${content || ''}`;
    const summary = parseJsonResponse(text);
    if (!summary) {
      throw new Error('HTTP knowledge response did not contain valid JSON.');
    }

    return normalizeSummary(summary);
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeCodexSummary(prompt, config, dependencies = {}) {
  const runCommand = dependencies.runCommand || runCommandCapture;
  const command = config.knowledge?.codexBin || 'codex';
  const outputFile = join(tmpdir(), `repochatmcp-codex-output-${sha1(prompt).slice(0, 10)}.json`);
  const schemaFile = join(tmpdir(), `repochatmcp-codex-schema-${sha1(JSON.stringify(KNOWLEDGE_SCHEMA)).slice(0, 10)}.json`);

  writeFileSync(schemaFile, JSON.stringify(KNOWLEDGE_SCHEMA, null, 2), 'utf8');

  const args = [
    'exec',
    '--cd',
    config.repoPath,
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-schema',
    schemaFile,
    '--output-last-message',
    outputFile,
  ];

  if (config.knowledge?.model) {
    args.push('--model', config.knowledge.model);
  }

  args.push('-');

  const result = await runCommand(command, args, {
    cwd: config.repoPath,
    timeoutMs: config.knowledge?.timeoutMs || 120000,
    input: prompt,
  });

  const rawOutput = readTextIfExists(outputFile) || result.stdout;
  if (result.code !== 0 && !rawOutput) {
    throw new Error(`Codex knowledge indexing failed: ${clip(result.stderr || result.stdout, 500)}`);
  }

  const summary = parseJsonResponse(rawOutput);
  if (!summary) {
    throw new Error('Codex knowledge response did not contain valid JSON.');
  }

  return normalizeSummary(summary);
}

async function resolveEffectiveBackend(config, dependencies = {}) {
  const mode = config.knowledge?.backend || 'off';

  if (mode === 'off') {
    return {
      enabled: false,
      backend: 'off',
      message: KNOWLEDGE_DISABLED_MESSAGE,
    };
  }

  const hasHttpConfig = Boolean(config.knowledge?.apiKey && config.knowledge?.model);

  if (mode === 'http') {
    if (!hasHttpConfig) {
      throw new Error(
        'HTTP knowledge indexing requires CHAT_SEARCH_KNOWLEDGE_API_KEY and CHAT_SEARCH_KNOWLEDGE_MODEL.',
      );
    }

    return {
      enabled: true,
      backend: 'http',
      model: config.knowledge.model,
    };
  }

  if (mode === 'auto' && hasHttpConfig) {
    return {
      enabled: true,
      backend: 'http',
      model: config.knowledge.model,
    };
  }

  const codex = await (dependencies.detectCodexBackend || detectCodexBackend)(config, dependencies);
  if (!codex.available) {
    throw new Error(codex.reason || 'Codex CLI is not available.');
  }
  if (!codex.loggedIn) {
    throw new Error(codex.reason || 'Codex CLI is not authenticated.');
  }

  return {
    enabled: true,
    backend: 'codex',
    model: config.knowledge?.model || codex.version || null,
  };
}

async function summarizeChunk(prompt, effectiveBackend, config, dependencies) {
  if (effectiveBackend.backend === 'http') {
    if (dependencies.invokeHttpSummary) {
      return normalizeSummary(await dependencies.invokeHttpSummary(prompt, config, dependencies));
    }
    return invokeHttpSummary(prompt, config, dependencies);
  }
  if (dependencies.invokeCodexSummary) {
    return normalizeSummary(await dependencies.invokeCodexSummary(prompt, config, dependencies));
  }
  return invokeCodexSummary(prompt, config, dependencies);
}

async function summarizeMessagesAdaptive(
  messages,
  {
    repoPath,
    effectiveBackend,
    config,
    dependencies,
    chunkIndex = 0,
    chunkCount = 1,
    minSplitMessages = 25,
  },
) {
  const prompt = buildChunkPrompt(messages, {
    repoPath,
    chunkIndex,
    chunkCount,
  });
  const summary = await summarizeChunk(prompt, effectiveBackend, config, dependencies);
  if (summaryHasContent(summary)) {
    return {
      summaries: [normalizeSummary(summary)],
      leafChunkCount: 1,
      retriedForEmptySummary: false,
    };
  }

  if (messages.length <= minSplitMessages) {
    return {
      summaries: [],
      leafChunkCount: 1,
      retriedForEmptySummary: false,
    };
  }

  const midpoint = Math.ceil(messages.length / 2);
  const left = await summarizeMessagesAdaptive(messages.slice(0, midpoint), {
    repoPath,
    effectiveBackend,
    config,
    dependencies,
    chunkIndex,
    chunkCount: chunkCount * 2,
    minSplitMessages,
  });
  const right = await summarizeMessagesAdaptive(messages.slice(midpoint), {
    repoPath,
    effectiveBackend,
    config,
    dependencies,
    chunkIndex: chunkIndex + 1,
    chunkCount: chunkCount * 2,
    minSplitMessages,
  });

  return {
    summaries: [...left.summaries, ...right.summaries],
    leafChunkCount: left.leafChunkCount + right.leafChunkCount,
    retriedForEmptySummary: true,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

function buildRunSummaryMetadata(messages, chunkCount, effectiveBackend, createdAt, runId) {
  return {
    runId,
    createdAt,
    backend: effectiveBackend.backend,
    messageCount: messages.length,
    chunkCount,
  };
}

function collectPendingMessages(messages, manifest, force = false) {
  if (force) {
    return {
      pendingMessages: messages,
      invalidRunIds: new Set(manifest.runs.map((run) => run.id)),
    };
  }

  const invalidRunIds = new Set();

  for (const message of messages) {
    const key = getMessageCacheKey(message);
    const entry = manifest.indexedMessages[key];
    if (entry && entry.hash !== getMessageCacheHash(message)) {
      invalidRunIds.add(entry.runId);
    }
  }

  const runMessageIds = new Map(
    manifest.runs.map((run) => [run.id, new Set(run.messageIds || [])]),
  );

  const pendingMessages = messages.filter((message) => {
    const key = getMessageCacheKey(message);
    const entry = manifest.indexedMessages[key];
    if (!entry) return true;
    if (invalidRunIds.has(entry.runId)) {
      return runMessageIds.get(entry.runId)?.has(key) ?? true;
    }
    return false;
  });

  return {
    pendingMessages,
    invalidRunIds,
  };
}

function activeRunsForOutput(config, manifest, provider) {
  return manifest.runs
    .filter((run) => !provider || run.provider === null || run.provider === provider)
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }
      return left.id.localeCompare(right.id);
    })
    .map((run) => ({
      id: run.id,
      createdAt: run.createdAt,
      backend: run.backend,
      provider: run.provider,
      providersIndexed: Array.isArray(run.providersIndexed) ? run.providersIndexed : null,
      sessionCountsByProvider: run.sessionCountsByProvider || null,
      messageCountsByProvider: run.messageCountsByProvider || null,
      messageCount: run.messageCount,
      firstMessageTs: run.firstMessageTs || null,
      lastMessageTs: run.lastMessageTs || null,
      chunkCount: run.chunkCount || null,
      inputChars: run.inputChars || null,
      outputChars: run.outputChars || null,
      model: run.model || null,
      retriedForEmptySummary: run.retriedForEmptySummary || false,
      filePath: join(getKnowledgeRoot(config), run.filePath),
    }));
}

function tailLines(text, maxLines) {
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length <= maxLines) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: lines.slice(-maxLines).join('\n'),
    truncated: true,
  };
}

function summarizeCompactionEntries(entries) {
  return entries.map((entry) => ({
    provider: entry.provider,
    sessionId: entry.sessionId,
    index: entry.index,
    timestamp: entry.timestamp,
    type: entry.type,
    score: entry.score,
    textChars: (entry.text || '').length,
  }));
}

function countSessionsByProvider(sessions) {
  const counts = {};
  for (const session of sessions) {
    counts[session.provider] = (counts[session.provider] || 0) + 1;
  }
  return counts;
}

function countMessagesByProvider(messages) {
  const counts = {};
  for (const message of messages) {
    counts[message.provider] = (counts[message.provider] || 0) + 1;
  }
  return counts;
}

function ensureKnowledgeSnapshotText(title, body, emptyMessage) {
  const trimmed = `${body || ''}`.trim();
  if (trimmed) return trimmed;
  return `# ${title}\n\n${emptyMessage}\n`;
}

function buildCombinedKnowledgeSnapshot({
  config,
  indexing,
  indexedRuns,
  indexedKnowledgeText,
}) {
  const parts = [
    '# Base Knowledge Snapshot',
    '',
    `Repository: ${config.repoPath}`,
    `Generated: ${nowIso()}`,
    `Indexing enabled: ${indexing.enabled ? 'yes' : 'no'}`,
    `Persisted run count: ${indexedRuns.length}`,
    '',
    '## Guidance',
    '',
    'Read this file first for the merged repository knowledge snapshot.',
    'If you need the original persisted summaries, open the indexed run files listed by chat.base_knowledge.',
    '',
    '## Persisted Indexed Knowledge',
    '',
    indexedKnowledgeText.trim() || 'No persisted indexed knowledge files were found.',
    '',
  ];

  return `${parts.join('\n').trim()}\n`;
}

export function buildBaseKnowledgeResponse(sessions, config, params = {}) {
  const manifest = loadKnowledgeManifest(config);
  const indexedRuns = activeRunsForOutput(config, manifest, params.provider);
  const indexedKnowledgeText = indexedRuns
    .map((run) => readTextIfExists(run.filePath))
    .filter(Boolean)
    .join('\n\n');
  const indexing = {
    enabled: knowledgeEnabled(config),
    backendMode: config.knowledge?.backend || 'off',
    message: knowledgeEnabled(config)
      ? 'Knowledge indexing is enabled.'
      : KNOWLEDGE_DISABLED_MESSAGE,
  };

  if (indexedRuns.length === 0) {
    if (knowledgeEnabled(config)) {
      indexing.message =
        'Knowledge indexing is enabled, but no persisted knowledge files exist yet. Run chat.knowledge_index to build them.';
    }
  } else if (knowledgeEnabled(config)) {
    indexing.message = `Loaded ${indexedRuns.length} persisted knowledge run(s).`;
  } else {
    indexing.message =
      `Knowledge indexing is disabled for new indexing, but loaded ${indexedRuns.length} persisted knowledge run(s).`;
  }

  const combinedKnowledgeText = buildCombinedKnowledgeSnapshot({
    config,
    indexing,
    indexedRuns,
    indexedKnowledgeText,
  });
  const combinedKnowledgeFilePath = writeKnowledgeTextToFile(combinedKnowledgeText);
  const tailed = tailLines(combinedKnowledgeText, MAX_COMBINED_KNOWLEDGE_LINES);

  const response = {
    indexing,
    indexedRuns,
    indexedKnowledgeFilePaths: indexedRuns.map((run) => run.filePath),
    combinedKnowledgeFilePath,
    combinedPreviewLineCount: tailed.text ? tailed.text.split('\n').length : 0,
    truncated: tailed.truncated,
    message:
      'Knowledge content is stored in files. Read combinedKnowledgeFilePath first, then inspect indexedRuns[].filePath for the persisted summaries.',
  };

  response.filePath = combinedKnowledgeFilePath;

  return response;
}

export function buildCompactionKnowledgeResponse(sessions, config, params = {}) {
  const compactionEntries = collectCompactionKnowledge(sessions, {
    limit: params.limit ?? 20,
    query: params.query,
    provider: params.provider,
  });
  const compactionsText = renderCompactionKnowledge(compactionEntries);
  const compactionsFilePath = writeKnowledgeTextToFile(
    ensureKnowledgeSnapshotText(
      'Live Compaction Knowledge',
      compactionsText,
      'No live compaction knowledge entries were found.',
    ),
  );

  const response = {
    compactionEntries: summarizeCompactionEntries(compactionEntries),
    compactionsFilePath,
    message:
      'Compaction knowledge is stored in a file. Read compactionsFilePath first.',
  };

  response.filePath = compactionsFilePath;
  return response;
}

export async function runKnowledgeIndex(sessions, config, params = {}, dependencies = {}) {
  if (!knowledgeEnabled(config)) {
    return {
      status: 'disabled',
      backend: 'off',
      messagesSeen: 0,
      newMessages: 0,
      pendingMessages: 0,
      filesWritten: 0,
      message: KNOWLEDGE_DISABLED_MESSAGE,
    };
  }

  const provider = params.provider || null;
  const force = params.force === true;
  const messages = flattenMessages(sessions, { provider });
  const sessionCountsByProvider = countSessionsByProvider(sessions);
  const messageCountsByProvider = countMessagesByProvider(messages);
  const providersIndexed = Object.keys(messageCountsByProvider).sort();
  const manifest = loadKnowledgeManifest(config);
  const { pendingMessages, invalidRunIds } = collectPendingMessages(messages, manifest, force);

  if (pendingMessages.length === 0) {
    const gitignorePath = ensureKnowledgeGitignore(config);
    return {
      status: 'skipped',
      backend: config.knowledge.backend,
      messagesSeen: messages.length,
      newMessages: 0,
      pendingMessages: 0,
      filesWritten: 0,
      providerFilter: provider,
      providersIndexed,
      sessionCountsByProvider,
      messageCountsByProvider,
      gitignorePath,
      message: 'No new messages to index.',
    };
  }

  if (pendingMessages.length < MIN_INDEXABLE_MESSAGES) {
    const gitignorePath = ensureKnowledgeGitignore(config);
    return {
      status: 'skipped',
      backend: config.knowledge.backend,
      messagesSeen: messages.length,
      newMessages: 0,
      pendingMessages: pendingMessages.length,
      filesWritten: 0,
      providerFilter: provider,
      providersIndexed,
      sessionCountsByProvider,
      messageCountsByProvider,
      gitignorePath,
      message: `Need at least ${MIN_INDEXABLE_MESSAGES} new messages before indexing.`,
    };
  }

  const effectiveBackend = await resolveEffectiveBackend(config, dependencies);
  const gitignorePath = ensureKnowledgeGitignore(config);
  const maxChars = Math.max(1, config.knowledge?.maxChars || 500000);
  const chunks = splitMessagesByChars(pendingMessages, maxChars);
  let chunkResults;
  if (effectiveBackend.backend === 'http') {
    chunkResults = await mapWithConcurrency(
      chunks,
      Math.max(1, config.knowledge?.httpConcurrency || 3),
      async (chunk, index) =>
        summarizeMessagesAdaptive(chunk, {
          repoPath: config.repoPath,
          effectiveBackend,
          config,
          dependencies,
          chunkIndex: index,
          chunkCount: chunks.length,
        }),
    );
  } else {
    chunkResults = [];
    for (let index = 0; index < chunks.length; index++) {
      chunkResults.push(
        await summarizeMessagesAdaptive(chunks[index], {
          repoPath: config.repoPath,
          effectiveBackend,
          config,
          dependencies,
          chunkIndex: index,
          chunkCount: chunks.length,
        }),
      );
    }
  }

  const chunkSummaries = chunkResults.flatMap((result) => result.summaries).filter(summaryHasContent);
  const effectiveChunkCount = chunkResults.reduce((sum, result) => sum + result.leafChunkCount, 0);
  const retriedForEmptySummary = chunkResults.some((result) => result.retriedForEmptySummary);

  if (chunkSummaries.length === 0) {
    throw new Error(
      'Knowledge indexing produced no usable summary content. Try a stronger model or reduce CHAT_SEARCH_KNOWLEDGE_MAX_CHARS.',
    );
  }

  let finalSummary = chunkSummaries[0];
  if (chunkSummaries.length > 1) {
    try {
      finalSummary = await summarizeChunk(
        buildMergePrompt(chunkSummaries, { repoPath: config.repoPath }),
        effectiveBackend,
        config,
        dependencies,
      );
      if (!summaryHasContent(finalSummary)) {
        finalSummary = mergeSummariesDeterministically(chunkSummaries);
      }
    } catch {
      finalSummary = mergeSummariesDeterministically(chunkSummaries);
    }
  }

  const createdAt = (dependencies.now || nowIso)();
  const runId = buildKnowledgeRunId(pendingMessages, createdAt);
  const relativePath = relativeRunPath(runId);
  const absolutePath = join(getKnowledgeRoot(config), relativePath);
  const markdown = renderKnowledgeSummary(
    finalSummary,
    buildRunSummaryMetadata(pendingMessages, effectiveChunkCount, effectiveBackend, createdAt, runId),
  );

  mkdirSync(getKnowledgeRunsDir(config), { recursive: true });
  writeFileSync(absolutePath, markdown, 'utf8');

  const nextManifest = force ? emptyManifest(config) : cloneManifest(manifest);
  const removedRuns = force
    ? [...manifest.runs]
    : nextManifest.runs.filter((run) => invalidRunIds.has(run.id));
  if (!force) {
    nextManifest.runs = nextManifest.runs.filter((run) => !invalidRunIds.has(run.id));
  }

  for (const [messageId, entry] of Object.entries(nextManifest.indexedMessages)) {
    if (force || invalidRunIds.has(entry.runId)) {
      delete nextManifest.indexedMessages[messageId];
    }
  }

  const runRecord = {
    id: runId,
    createdAt,
    backend: effectiveBackend.backend,
    provider,
    providersIndexed,
    sessionCountsByProvider,
    messageCountsByProvider,
    messageCount: pendingMessages.length,
    firstMessageTs: pendingMessages[0]?.timestamp || null,
    lastMessageTs: pendingMessages[pendingMessages.length - 1]?.timestamp || null,
    messageIds: pendingMessages.map((message) => getMessageCacheKey(message)),
    filePath: relativePath,
    chunkCount: effectiveChunkCount,
    inputChars: serializeTranscript(pendingMessages).length,
    outputChars: markdown.length,
    configFingerprint: configFingerprint(config),
    model: config.knowledge?.model || null,
    retriedForEmptySummary,
  };

  nextManifest.configFingerprint = configFingerprint(config);
  nextManifest.runs.push(runRecord);
  nextManifest.runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const message of pendingMessages) {
    const key = getMessageCacheKey(message);
    nextManifest.indexedMessages[key] = {
      hash: getMessageCacheHash(message),
      indexedAt: createdAt,
      runId,
    };
  }

  saveKnowledgeManifest(config, nextManifest);

  for (const run of removedRuns) {
    const oldPath = join(getKnowledgeRoot(config), run.filePath);
    if (oldPath !== absolutePath && fileExists(oldPath)) {
      rmSync(oldPath, { force: true });
    }
  }

  cleanupUnreferencedRunFiles(config, nextManifest.runs);

  return {
    status: 'indexed',
    backend: effectiveBackend.backend,
    messagesSeen: messages.length,
    newMessages: pendingMessages.length,
    pendingMessages: 0,
    filesWritten: 1,
    chunkCount: effectiveChunkCount,
    providerFilter: provider,
    providersIndexed,
    sessionCountsByProvider,
    messageCountsByProvider,
    retriedForEmptySummary,
    filePath: absolutePath,
    gitignorePath,
    runId,
  };
}

export const __private = {
  KNOWLEDGE_SCHEMA,
  buildChunkPrompt,
  buildMergePrompt,
  collectPendingMessages,
  ensureKnowledgeGitignore,
  gitignoreAlreadyCoversKnowledge,
  configFingerprint,
  invokeCodexSummary,
  invokeHttpSummary,
  isOpenRouterBaseUrl,
  mergeSummariesDeterministically,
  parseJsonResponse,
  parseProviderPinnedModel,
  resolveEffectiveBackend,
  runCommandCapture,
  summaryHasContent,
  tailLines,
};
