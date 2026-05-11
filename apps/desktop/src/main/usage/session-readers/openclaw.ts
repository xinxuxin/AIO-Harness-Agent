/**
 * Reads token usage from OpenClaw agent session files.
 *
 * Session files live at:
 *   ~/.openclaw/agents/<agent-name>/sessions/<session-id>.jsonl
 *
 * Each file is a JSONL stream:
 *   - First line: { type: "session", cwd: "..." }
 *   - Other lines: { type: "message", timestamp: "<ISO>", message: { role, usage, model, provider } }
 *
 * We collect assistant messages where usage.input > 0 || usage.output > 0 || usage.totalTokens > 0.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord } from '../types.js';

const OPENCLAW_AGENTS_DIR = join(homedir(), '.openclaw', 'agents');

interface OpenClawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface OpenClawMessage {
  role?: string;
  model?: string;
  provider?: string;
  usage?: OpenClawUsage;
}

interface OpenClawRecord {
  type?: string;
  timestamp?: string;
  cwd?: string;
  message?: OpenClawMessage;
}

/** Scan a single session JSONL file and return usage records from it. */
function scanSessionFile(filePath: string, fromTs?: number, toTs?: number): UsageRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  let cwd: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: OpenClawRecord;
    try {
      rec = JSON.parse(trimmed) as OpenClawRecord;
    } catch {
      continue;
    }

    // Grab cwd from session header
    if (rec.type === 'session' && rec.cwd) {
      cwd = rec.cwd;
      continue;
    }

    if (rec.type !== 'message') continue;
    const msg = rec.message;
    if (!msg || msg.role !== 'assistant') continue;

    const u = msg.usage;
    if (!u) continue;

    const inputTokens = u.input ?? 0;
    const outputTokens = u.output ?? 0;
    const cachedTokens = u.cacheRead ?? 0;
    const totalTokens = u.totalTokens ?? 0;

    // Skip records with no meaningful usage
    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) continue;

    // Parse timestamp
    const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : Date.now();
    if (isNaN(ts)) continue;
    if (fromTs !== undefined && ts < fromTs) continue;
    if (toTs !== undefined && ts >= toTs) continue;

    records.push({
      ts,
      agentId: 'openclaw',
      providerId: msg.provider ?? 'openclaw',
      model: msg.model ?? 'unknown',
      inputTokens,
      outputTokens,
      cachedTokens,
      cwd,
    });
  }

  return records;
}

/** Collect all plain session JSONL files across all openclaw agents. */
export function collectOpenClawSessionFiles(): string[] {
  if (!existsSync(OPENCLAW_AGENTS_DIR)) return [];

  const files: string[] = [];
  let agentEntries: string[];
  try {
    agentEntries = readdirSync(OPENCLAW_AGENTS_DIR);
  } catch {
    return [];
  }

  for (const agentName of agentEntries) {
    const sessionsDir = join(OPENCLAW_AGENTS_DIR, agentName, 'sessions');
    if (!existsSync(sessionsDir)) continue;

    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(sessionsDir);
    } catch {
      continue;
    }

    for (const fn of sessionFiles) {
      // Only plain .jsonl files (not .trajectory., .checkpoint., .deleted)
      if (!fn.endsWith('.jsonl')) continue;
      if (fn.includes('.trajectory.')) continue;
      if (fn.includes('.checkpoint.')) continue;
      if (fn.includes('.deleted')) continue;

      const fullPath = join(sessionsDir, fn);
      try {
        const st = statSync(fullPath);
        if (st.isFile()) files.push(fullPath);
      } catch {
        // ignore
      }
    }
  }

  return files;
}

/**
 * Scan all OpenClaw agent session files and return usage records,
 * optionally filtered by time range.
 */
export function scanOpenClawSessions(fromTs?: number, toTs?: number): UsageRecord[] {
  const files = collectOpenClawSessionFiles();
  const results: UsageRecord[] = [];
  for (const f of files) {
    results.push(...scanSessionFile(f, fromTs, toTs));
  }
  return results;
}
