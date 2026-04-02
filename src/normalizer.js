import { basename } from 'path';
import { readJsonLines } from './utils.js';

const SKIP_TYPES = new Set([
  'file-history-snapshot',
  'last-prompt',
  'ai-title',
  'queue-operation',
  'progress',
]);

/**
 * Extract text from Claude content array/string.
 */
function extractClaudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const inputStr = block.input ? JSON.stringify(block.input) : '{}';
      parts.push(`[tool: ${block.name || 'unknown'}] ${inputStr}`);
    } else if (block.type === 'tool_result') {
      const resultContent = extractToolResultContent(block.content);
      parts.push(`[result] ${resultContent}`);
    } else if (block.type === 'thinking') {
      // Skip thinking blocks
    }
  }
  return parts.join('\n');
}

/**
 * Extract content from a tool_result block's content.
 */
function extractToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (item.type === 'text' && item.text) {
      parts.push(item.text);
    }
  }
  return parts.join('\n');
}

/**
 * Check if Claude content array contains any tool_use blocks.
 */
function hasToolUse(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === 'tool_use');
}

/**
 * Check if Claude content array contains tool_result items.
 */
function hasToolResult(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => block.type === 'tool_result');
}

/**
 * Parse a Claude JSONL session file into normalized messages.
 */
function parseClaudeSession(filePath, lines) {
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let startedAt = null;
  let endedAt = null;
  const messages = [];
  let index = 0;

  for (const { value: line } of lines) {
    // Extract session metadata from any line
    if (!sessionId) {
      sessionId = line.sessionId || line.message?.sessionId || null;
    }
    if (!cwd && line.cwd) {
      cwd = line.cwd;
    }
    if (!gitBranch && line.gitBranch) {
      gitBranch = line.gitBranch;
    }

    const lineType = line.type;

    // Skip non-message types
    if (SKIP_TYPES.has(lineType)) continue;

    const timestamp = line.timestamp || null;
    if (timestamp) {
      if (!startedAt) startedAt = timestamp;
      endedAt = timestamp;
    }

    if (lineType === 'user' && line.message?.role === 'user') {
      const content = line.message.content;
      if (hasToolResult(content)) {
        messages.push({
          provider: 'claude',
          sessionId,
          index: index++,
          timestamp,
          type: 'tool_result',
          role: 'user',
          text: extractClaudeText(content),
          metadata: {},
        });
      } else {
        const text = typeof content === 'string' ? content : extractClaudeText(content);
        messages.push({
          provider: 'claude',
          sessionId,
          index: index++,
          timestamp,
          type: 'user',
          role: 'user',
          text,
          metadata: {},
        });
      }
    } else if (lineType === 'assistant') {
      const content = line.message?.content || [];
      const text = extractClaudeText(content);
      const type = hasToolUse(content) ? 'tool_call' : 'assistant';

      messages.push({
        provider: 'claude',
        sessionId,
        index: index++,
        timestamp,
        type,
        role: 'assistant',
        text,
        metadata: {},
      });
    } else if (lineType === 'system') {
      const text = typeof line.message?.content === 'string'
        ? line.message.content
        : extractClaudeText(line.message?.content || []);
      messages.push({
        provider: 'claude',
        sessionId,
        index: index++,
        timestamp,
        type: 'system',
        role: 'system',
        text,
        metadata: {},
      });
    }
  }

  // Fallback sessionId from filename
  if (!sessionId) {
    sessionId = basename(filePath, '.jsonl');
  }

  return {
    provider: 'claude',
    sessionId,
    cwd,
    gitBranch,
    startedAt,
    endedAt,
    messageCount: messages.length,
    messages,
  };
}

/**
 * Extract text from Codex message content array.
 */
function extractCodexText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * Parse a Codex JSONL session file into normalized messages.
 */
function parseCodexSession(filePath, lines) {
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let startedAt = null;
  let endedAt = null;
  const messages = [];
  let index = 0;

  for (const { value: line } of lines) {
    const recordType = line.type || line.record_type;
    const timestamp = line.timestamp || null;

    if (timestamp) {
      if (!startedAt) startedAt = timestamp;
      endedAt = timestamp;
    }

    if (recordType === 'session_meta') {
      sessionId = line.payload?.id || sessionId;
      cwd = line.payload?.cwd || cwd;
      gitBranch = line.payload?.git?.branch || gitBranch;
      continue;
    }

    if (recordType === 'turn_context') {
      // Just updates cwd; skip as message
      if (line.payload?.cwd) cwd = line.payload.cwd;
      continue;
    }

    if (recordType === 'state') {
      continue;
    }

    if (recordType === 'response_item' && line.payload?.type === 'message') {
      const role = line.payload.role;
      const content = line.payload.content || [];
      const text = extractCodexText(content);

      if (role === 'user') {
        messages.push({
          provider: 'codex',
          sessionId,
          index: index++,
          timestamp,
          type: 'user',
          role: 'user',
          text,
          metadata: {},
        });
      } else if (role === 'assistant') {
        messages.push({
          provider: 'codex',
          sessionId,
          index: index++,
          timestamp,
          type: 'assistant',
          role: 'assistant',
          text,
          metadata: {},
        });
      } else if (role === 'developer') {
        messages.push({
          provider: 'codex',
          sessionId,
          index: index++,
          timestamp,
          type: 'system',
          role: 'developer',
          text,
          metadata: {},
        });
      }
      continue;
    }

    if (recordType === 'compacted') {
      messages.push({
        provider: 'codex',
        sessionId,
        index: index++,
        timestamp,
        type: 'compaction',
        role: 'system',
        text: line.payload?.message || '',
        metadata: {
          replacementHistory: line.payload?.replacement_history || null,
        },
      });
      continue;
    }

    if (recordType === 'event_msg' && line.payload?.type === 'user_message') {
      messages.push({
        provider: 'codex',
        sessionId,
        index: index++,
        timestamp,
        type: 'user',
        role: 'user',
        text: line.payload.message || '',
        metadata: {},
      });
      continue;
    }

    if (recordType === 'item.completed' && line.item?.type === 'agent_message') {
      messages.push({
        provider: 'codex',
        sessionId,
        index: index++,
        timestamp,
        type: 'assistant',
        role: 'assistant',
        text: line.item.text || '',
        metadata: {},
      });
      continue;
    }
  }

  // Fallback sessionId from filename
  if (!sessionId) {
    sessionId = basename(filePath, '.jsonl');
  }

  return {
    provider: 'codex',
    sessionId,
    cwd,
    gitBranch,
    startedAt,
    endedAt,
    messageCount: messages.length,
    messages,
  };
}

/**
 * Parse and normalize a session file to unified format.
 */
export function normalizeSession(filePath, provider, options = {}) {
  const lines = readJsonLines(filePath);

  if (provider === 'claude') {
    return parseClaudeSession(filePath, lines);
  } else if (provider === 'codex') {
    return parseCodexSession(filePath, lines);
  }

  throw new Error(`Unknown provider: ${provider}`);
}
