/** Small, dependency-free helpers shared by the guard's pure modules. */
import { createHash } from 'node:crypto';

/** Stable short digest of arbitrary text (audit-safe: never the text itself). */
export function digest(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/**
 * Canonical JSON: key order must not change a tool call's identity, otherwise
 * the same call with reordered fields reads as new work.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** Identity of one tool attempt: tool name + canonical arguments. */
export function callKey(tool, args) {
  return `${tool}\u0000${digest(canonical(args))}`;
}

/** Identity of one completed attempt, including what it actually produced. */
export function outcomeKey(tool, args, outcome) {
  return `${callKey(tool, args)}\u0000${digest(outcome)}`;
}

/** Tokens that cost real money on every provider seen here. */
export function totalTokens(usage) {
  return (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.reasoning ?? 0);
}

/** Currency units for one usage record under a per-1e6 pricing table. */
export function costOf(usage, pricing) {
  if (!pricing || typeof pricing !== 'object') return 0;
  const rate = (key) => (typeof pricing[key] === 'number' ? pricing[key] : 0);
  return (
    ((usage?.input ?? 0) * rate('input')
      + (usage?.output ?? 0) * rate('output')
      + (usage?.cacheRead ?? 0) * rate('cacheRead')
      + (usage?.reasoning ?? 0) * Math.max(rate('reasoning'), rate('output'))) / 1e6
  );
}

/** Insertion-ordered bounded map: oldest entries evicted past `cap`. */
export function remember(map, key, value, cap) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Rolling counter window (calls/tokens/progress inside `windowMs`). */
export function rollWindow(window, windowMs, now) {
  if (now - window.start >= windowMs) {
    window.start = now;
    window.tokens = 0;
    window.calls = 0;
    window.novel = 0;
    window.artifact = 0;
    window.ledger = 0;
    window.refusals = 0;
  }
  return window;
}

/** Rate limiter over timestamps inside a rolling window. */
export function countSince(timestamps, sinceMs, now) {
  let n = 0;
  for (const ts of timestamps) if (now - ts <= sinceMs) n += 1;
  return n;
}

export function trimTimestamps(timestamps, keepMs, now) {
  const kept = timestamps.filter((ts) => now - ts <= keepMs);
  timestamps.length = 0;
  timestamps.push(...kept);
  return timestamps;
}

/** Match a tool name against an exact list or `prefix*` wildcard entries. */
export function matchesTool(name, patterns) {
  for (const pattern of patterns ?? []) {
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern === name) return true;
  }
  return false;
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n ?? 0);
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Is this call "heavy"? Two very different kinds of weight, deliberately kept
 * apart from ordinary shell traffic:
 *   1. orchestrator/spawner tools — two at once can drag the machine down;
 *   2. a shell command that looks like a full *suite* (clone / whole test run),
 *      which is the measured pattern behind "12 full-repo copies in 36 minutes".
 * A plain `ls`/`grep`/`cat` is never heavy: capping those would block normal work.
 */
export function isHeavyCall(tool, args, cfg) {
  if (matchesTool(tool, cfg.heavy.tools)) return true;
  if (!matchesTool(tool, cfg.heavy.suiteTools)) return false;
  const pattern = cfg.heavy.suitePattern;
  if (!pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(canonical(args));
  } catch {
    return false;
  }
}
