/**
 * Per-session tracker: the raw facts the guard judges.
 *
 * Deliberately content-free: it keeps digests and counters, never prompts,
 * commands, or tool output. That keeps the guard cheap, and keeps its audit
 * file safe to hand around after an incident.
 */
import { callKey, canonical, costOf, countSince, digest, isHeavyCall, matchesTool, outcomeKey, remember, rollWindow, totalTokens, trimTimestamps } from './util.js';

/** Result text that means "I was not allowed to do that". */
const REFUSAL_RE = /(denied|not allowed|forbidden|refused|permission|task status cannot|already completed|已终态|无法|拒绝|不允许|被拒)/i;

export function createTracker({ id, label = '', now = Date.now(), cfg }) {
  return {
    id,
    label,
    createdAt: now,
    lastEventAt: now,
    lastHumanAt: now,
    lastNovelAt: 0,
    lastArtifactAt: 0,
    lastLedgerAt: 0,
    attempts: 0,
    results: 0,
    errors: 0,
    novel: 0,
    heavy: new Map(),
    heavyRecent: [],
    repeatKey: '',
    repeatTool: '',
    repeatRun: 0,
    maxRun: 0,
    lastOutcomeKey: '',
    sameOutcomeRun: 0,
    maxSameOutcomeRun: 0,
    toolCounts: new Map(),
    refusals: new Map(),
    usage: { input: 0, output: 0, cacheRead: 0, reasoning: 0, steps: 0, yuan: 0 },
    window: { start: now, tokens: 0, calls: 0, novel: 0, artifact: 0, ledger: 0, refusals: 0 },
    seen: new Map(),
    turns: { open: 0, current: 0, startedAt: 0, lastEndAt: 0, lastReason: '' },
    nudges: new Map(),
    verdicts: [],
    lastAuditAt: 0,
    cfg,
  };
}

/** Every session event refreshes the heartbeat that `stalled` depends on. */
export function noteEvent(tracker, at) {
  tracker.lastEventAt = at;
}

export function noteHumanMessage(tracker, at) {
  tracker.lastHumanAt = at;
  tracker.lastEventAt = at;
}

export function noteTurnStart(tracker, turn, at) {
  tracker.turns.open = 1;
  tracker.turns.current = turn ?? tracker.turns.current;
  tracker.turns.startedAt = at;
  tracker.lastEventAt = at;
}

export function noteTurnEnd(tracker, reason, at) {
  tracker.turns.open = 0;
  tracker.turns.lastEndAt = at;
  tracker.turns.lastReason = typeof reason?.kind === 'string' ? reason.kind : '';
  tracker.lastEventAt = at;
}

/**
 * One tool attempt, counted *before* execution — so a call that is later denied
 * still counts (a model hammering a denied call is exactly the loop to break).
 */
export function noteAttempt(tracker, { tool, args, at, cfg, callId }) {
  tracker.attempts += 1;
  tracker.lastEventAt = at;
  rollWindow(tracker.window, cfg.idle.windowMs, at);
  tracker.window.calls += 1;
  tracker.toolCounts.set(tool, (tracker.toolCounts.get(tool) ?? 0) + 1);

  const key = callKey(tool, args);
  if (key === tracker.repeatKey) {
    tracker.repeatRun += 1;
  } else {
    tracker.repeatKey = key;
    tracker.repeatTool = tool;
    tracker.repeatRun = 1;
  }
  tracker.maxRun = Math.max(tracker.maxRun, tracker.repeatRun);

  if (isHeavyCall(tool, args, cfg)) {
    tracker.heavy.set(callId ?? `anon-${at}-${tracker.heavy.size}`, { tool, at });
    tracker.heavyRecent.push(at);
    trimTimestamps(tracker.heavyRecent, 600_000, at);
  }
  return { run: tracker.repeatRun, key };
}

/**
 * Release a heavy-call slot once that call settles.
 *
 * Slot bookkeeping is keyed by callId and self-pruning: a call whose result
 * never arrives (killed process, denied call, host restart) would otherwise pin
 * the slot forever and make the concurrency limit block everything afterwards.
 */
export function noteHeavySettled(tracker, { callId, at }) {
  if (callId !== undefined) tracker.heavy.delete(callId);
  if (at !== undefined) tracker.lastEventAt = at;
}

/**
 * One completed tool call. Novelty is (tool, arguments, outcome): repeating the
 * same call and getting the same answer is not progress, however expensive.
 */
export function noteResult(tracker, { tool, args, outcome, isError = false, at, cfg }) {
  tracker.results += 1;
  tracker.lastEventAt = at;
  if (isError) tracker.errors += 1;
  rollWindow(tracker.window, cfg.idle.windowMs, at);

  const text = typeof outcome === 'string' ? outcome : JSON.stringify(outcome ?? '');
  const key = outcomeKey(tool, args, text);
  if (key === tracker.lastOutcomeKey) {
    tracker.sameOutcomeRun += 1;
  } else {
    tracker.lastOutcomeKey = key;
    tracker.sameOutcomeRun = 1;
  }
  tracker.maxSameOutcomeRun = Math.max(tracker.maxSameOutcomeRun, tracker.sameOutcomeRun);
  const novel = !tracker.seen.has(key);
  if (novel) {
    remember(tracker.seen, key, at, cfg.progress.seenCap);
    tracker.novel += 1;
    tracker.window.novel += 1;
    tracker.lastNovelAt = at;
    if (matchesTool(tool, cfg.progress.artifactTools)) {
      tracker.window.artifact += 1;
      tracker.lastArtifactAt = at;
    }
    if (matchesTool(tool, cfg.progress.ledgerTools)) {
      tracker.window.ledger += 1;
      tracker.lastLedgerAt = at;
    }
  }

  if (REFUSAL_RE.test(text) || isError) {
    const entry = tracker.refusals.get(tool) ?? { count: 0, at: 0, sample: '' };
    if (REFUSAL_RE.test(text)) {
      entry.count += 1;
      entry.at = at;
      entry.sample = digest(`${canonical(args)}|${text}`);
      tracker.window.refusals += 1;
      tracker.refusals.set(tool, entry);
    }
  }
  return { novel };
}

/** One usage record from the provider (`assistant/chunk` → `usage`). */
export function noteUsage(tracker, usage, at, cfg) {
  tracker.usage.input += usage?.inputTokens ?? 0;
  tracker.usage.output += usage?.outputTokens ?? 0;
  tracker.usage.cacheRead += usage?.cacheReadTokens ?? 0;
  tracker.usage.reasoning += usage?.reasoningTokens ?? 0;
  tracker.usage.steps += 1;
  const tokens = totalTokens({
    input: usage?.inputTokens, output: usage?.outputTokens,
    cacheRead: usage?.cacheReadTokens, reasoning: usage?.reasoningTokens,
  });
  rollWindow(tracker.window, cfg.idle.windowMs, at);
  tracker.window.tokens += tokens;
  tracker.usage.yuan += costOfSafe(usage, cfg);
  tracker.lastEventAt = at;
  return tokens;
}

function costOfSafe(usage, cfg) {
  const pricing = cfg?.budget?.pricing;
  if (!pricing || typeof pricing !== 'object') return 0;
  // v0.1 prices a single flat table (`*`); per-provider routing is v0.2.
  const flat = pricing['*'] ?? pricing.default ?? pricing;
  if (typeof flat !== 'object') return 0;
  return costOf({
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
  }, flat);
}

/** Refusals of one tool inside the rolling window (the "claim rejected ×6" shape). */
export function refusalCount(tracker, tool, windowMs, now) {
  const entry = tracker.refusals.get(tool);
  if (!entry || now - entry.at > windowMs) return 0;
  return entry.count;
}

/**
 * Current heavy-call pressure. `excludeCallId` removes the caller's own call so
 * the limit means "N *other* heavy calls already running".
 */
export function heavyLoad(tracker, cfg, now, excludeCallId) {
  const deadline = now - cfg.heavy.timeoutMs;
  for (const [callId, entry] of tracker.heavy) {
    if (entry.at < deadline) tracker.heavy.delete(callId); // presumed reaped
  }
  let inFlight = tracker.heavy.size;
  if (excludeCallId !== undefined && tracker.heavy.has(excludeCallId)) inFlight -= 1;
  return {
    inFlight,
    last10min: countSince(tracker.heavyRecent, 600_000, now),
    cap: cfg.heavy.maxConcurrent,
    rateCap: cfg.heavy.maxPer10Min,
  };
}

export function tokenTotals(tracker) {
  return totalTokens(tracker.usage);
}

/**
 * Heavy calls in flight across *all* sessions. 卡死不是单个会话造成的，而是
 * "很多会话同时干重活"；这个计数就是那道宿主级闸的依据。
 */
export function hostHeavyInFlight(trackers, cfg, now, excludeCallId) {
  let total = 0;
  for (const tracker of trackers) total += heavyLoad(tracker, cfg, now, excludeCallId).inFlight;
  return total;
}
