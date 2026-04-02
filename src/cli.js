import { parseArgs } from './utils.js';
import { resolveConfig } from './config.js';
import { runMcpServer } from './mcp/server.js';
import { discoverSessionFiles } from './discovery.js';
import { normalizeSession } from './normalizer.js';
import { searchMessages } from './search.js';

export function main(argv) {
  const parsed = parseArgs(argv);
  const command = parsed._[0] || 'mcp';
  const config = resolveConfig(parsed.flags);

  if (command === 'mcp') {
    runMcpServer(config);
  } else if (command === 'search') {
    runSearch(config, parsed);
  } else if (command === 'status') {
    runStatus(config);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error('Usage: chat-search [mcp|search|status] [options]');
    process.exit(1);
  }
}

function runSearch(config, parsed) {
  const query = parsed._[1] || parsed.flags.query;
  if (!query) {
    console.error('Usage: chat-search search <query> [--limit N] [--provider claude|codex]');
    process.exit(1);
  }

  const sessionFiles = discoverSessionFiles(config);
  if (sessionFiles.length === 0) {
    console.log('No sessions found for this repo.');
    return;
  }

  const sessions = [];
  for (const { filePath, provider } of sessionFiles) {
    try {
      sessions.push(normalizeSession(filePath, provider));
    } catch {
      // skip unparseable files
    }
  }

  const results = searchMessages(sessions, {
    query,
    provider: parsed.flags.provider,
    limit: parsed.flags.limit ? Number(parsed.flags.limit) : config.defaultLimit,
    contextMessages: parsed.flags.context ? Number(parsed.flags.context) : config.defaultContextMessages,
  });

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (const result of results) {
    const msg = result.message;
    const prefix = `[${msg.provider}:${msg.sessionId}#${msg.index}]`;
    const typeTag = `(${msg.type})`;
    const snippet = (msg.text || '').slice(0, 200).replace(/\n/g, ' ');
    console.log(`${prefix} ${typeTag} score=${result.score}`);
    console.log(`  ${snippet}`);
    console.log();
  }
}

function runStatus(config) {
  console.log(`Repo path: ${config.repoPath}`);
  console.log(`Claude root: ${config.claudeRoot}`);
  console.log(`Codex sessions: ${config.codexSessionsRoot}`);
  console.log(`Codex archived: ${config.codexArchivedRoot}`);
  console.log();

  const sessionFiles = discoverSessionFiles(config);

  const claudeCount = sessionFiles.filter((f) => f.provider === 'claude').length;
  const codexCount = sessionFiles.filter((f) => f.provider === 'codex' && !f.archived).length;
  const archivedCount = sessionFiles.filter((f) => f.archived).length;

  console.log(`Claude sessions: ${claudeCount}`);
  console.log(`Codex sessions:  ${codexCount}`);
  console.log(`Archived:        ${archivedCount}`);
  console.log(`Total:           ${sessionFiles.length}`);
}
