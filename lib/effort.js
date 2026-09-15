/**
 * The judgement layer: turn raw counters into named verdicts.
 *
 * Design rule learned the hard way on this host: wall-clock time may never be
 * the *only* reason to call something a loop. Seven sessions once stalled ~900s
 * at the same moment purely because of provider transport retries; a
 * time-based "infinite loop" detector would have killed the whole team.
 * Every verdict below therefore rests on a discrete count, and `stalled`
 * (the one time-based verdict) can never trigger a rejection.
 */
import { fmtDuration, fmtTokens } from './util.js';
import { refusalCount } from './store.js';

export const SEVERITY = { info: 'info', warn: 'warn', critical: 'critical' };

function verdict(kind, severity, text, evidence) {
  return { kind, severity, text, evidence };
}

/** Time-based: no session event for a while while a turn is still open. */
function stalledVerdicts(tracker, cfg, now) {
  if (!tracker.turns.open) return [];
  const idle = now - tracker.lastEventAt;
  if (idle >= cfg.heartbeat.parkMs) {
    return [verdict('stalled', SEVERITY.critical,
      `会话已停滞 ${fmtDuration(idle)}（turn ${tracker.turns.current} 仍开启）——可能是长命令、provider 重试或真卡死，需要人看一眼`,
      { idleMs: idle, turn: tracker.turns.current, parked: true })];
  }
  if (idle >= cfg.heartbeat.suspectMs) {
    return [verdict('stalled', SEVERITY.warn,
      `会话 ${fmtDuration(idle)} 没有新事件（turn ${tracker.turns.current} 仍开启）——列入观察，不采取动作`,
      { idleMs: idle, turn: tracker.turns.current })];
  }
  return [];
}

/**
 * Discrete: consecutive identical calls.
 *
 * Two tiers on purpose. Identical *arguments* alone are not actionable — polling
 * the same command while its output keeps changing is legitimate work. Repeating
 * the same call and getting the *same answer* is the shape that burns money:
 * that is what the 180-identical-failures-in-19-minutes incident looked like.
 */
function repeatingVerdicts(tracker, cfg) {
  const same = tracker.sameOutcomeRun;
  if (same >= cfg.repeats.critical) {
    return [verdict('repeating', SEVERITY.critical,
      `连续 ${same} 次调用 \`${tracker.repeatTool}\` 且参数与结果完全相同（实测本机合法上限为 3）`,
      { tool: tracker.repeatTool, run: same, argRun: tracker.repeatRun, threshold: cfg.repeats.critical, identicalOutcome: true })];
  }
  if (same >= cfg.repeats.warn) {
    return [verdict('repeating', SEVERITY.warn,
      `连续 ${same} 次调用 \`${tracker.repeatTool}\` 且参数与结果完全相同`,
      { tool: tracker.repeatTool, run: same, argRun: tracker.repeatRun, threshold: cfg.repeats.warn, identicalOutcome: true })];
  }
  // Same command, changing output: surface it, never act on it.
  if (tracker.repeatRun >= cfg.repeats.warn * 2) {
    return [verdict('polling', SEVERITY.info,
      `连续 ${tracker.repeatRun} 次调用 \`${tracker.repeatTool}\` 参数相同但结果在变（像在轮询，属正常）`,
      { tool: tracker.repeatTool, argRun: tracker.repeatRun, identicalOutcome: false })];
  }
  return [];
}

/** Discrete: the same tool keeps being refused (the "claim rejected ×6" shape). */
function refusingVerdicts(tracker, cfg, now) {
  const out = [];
  for (const [tool, entry] of tracker.refusals) {
    const count = refusalCount(tracker, tool, cfg.idle.windowMs, now);
    if (count >= cfg.refusals.limit) {
      out.push(verdict(count >= cfg.refusals.limit * 2 ? 'refusing' : 'refusing', SEVERITY.warn,
        `\`${tool}\` 在窗口内被拒绝 ${count} 次（阈值 ${cfg.refusals.limit}）——继续重试同一动作不会改变结果`,
        { tool, count, threshold: cfg.refusals.limit }));
    }
  }
  return out;
}

/**
 * The headline check: spent a lot, moved nothing.
 * "Moved nothing" = no novel artifact result AND no novel ledger result inside
 * the window. Merely *waiting* (no spend) is never spinning.
 */
function spinningVerdicts(tracker, cfg, now) {
  const w = tracker.window;
  if (w.tokens < cfg.idle.minTokens) return [];
  if (w.calls < cfg.idle.minToolCalls) return [];
  const sinceHuman = now - Math.max(tracker.createdAt, tracker.lastHumanAt);
  if (sinceHuman < cfg.idle.graceMs) return [];
  // Age-based, not window-counter-based: one novel result at the very start of a
  // window must not authorise a whole window of silence afterwards.
  // Still active? A silent session is `stalled`, not `spinning` — do not report
  // "burning while doing nothing" about work that has simply stopped.
  if (now - tracker.lastEventAt > cfg.idle.windowMs) return [];
  const lastProgress = Math.max(tracker.lastArtifactAt, tracker.lastLedgerAt, tracker.createdAt);
  const silentFor = now - lastProgress;
  if (silentFor < cfg.idle.windowMs) return [];
  const spent = fmtTokens(w.tokens);
  return [verdict('spinning', SEVERITY.critical,
    `最近 ${fmtDuration(silentFor)} 没有产生任何新产物或台账推进，却已花掉 ${spent} tokens / ${w.calls} 次工具调用`,
    {
      windowTokens: w.tokens, windowCalls: w.calls, windowNovel: w.novel,
      silentForMs: silentFor,
      lastArtifactAgoMs: tracker.lastArtifactAt ? now - tracker.lastArtifactAt : null,
      lastLedgerAgoMs: tracker.lastLedgerAt ? now - tracker.lastLedgerAt : null,
    })];
}

/** Opt-in: heavy spend with essentially no tool activity (see defaults.burn). */
function burningVerdicts(tracker, cfg, now) {
  if (cfg.burn.minTokens <= 0) return [];
  const w = tracker.window;
  if (w.tokens < cfg.burn.minTokens) return [];
  if (w.calls > cfg.burn.maxToolCalls) return [];
  if (now - tracker.lastEventAt > cfg.burn.windowMs) return [];
  const lastProgress = Math.max(tracker.lastArtifactAt, tracker.lastLedgerAt, tracker.createdAt);
  if (now - lastProgress < cfg.burn.windowMs) return [];
  return [verdict('burning', SEVERITY.warn,
    `最近 ${fmtDuration(cfg.burn.windowMs)} 花了 ${fmtTokens(w.tokens)} tokens，但几乎没有工具活动（${w.calls} 次）`,
    { windowTokens: w.tokens, windowCalls: w.calls, window: cfg.burn.windowMs })];
}

/** Hard budgets. All three are off by default (0 = off). */
function budgetVerdicts(tracker, cfg, now) {
  const out = [];
  const tokens = tracker.usage.input + tracker.usage.output + tracker.usage.cacheRead + tracker.usage.reasoning;
  if (cfg.budget.perSessionTokens > 0 && tokens >= cfg.budget.perSessionTokens) {
    out.push(verdict('over-budget', SEVERITY.critical,
      `本会话已用 ${fmtTokens(tokens)} tokens，超过预算 ${fmtTokens(cfg.budget.perSessionTokens)}`,
      { tokens, limit: cfg.budget.perSessionTokens, unit: 'tokens' }));
  }
  if (cfg.budget.perSessionYuan > 0 && tracker.usage.yuan >= cfg.budget.perSessionYuan) {
    out.push(verdict('over-budget', SEVERITY.critical,
      `本会话已花费 ${tracker.usage.yuan.toFixed(2)}（预算 ${cfg.budget.perSessionYuan}）`,
      { yuan: tracker.usage.yuan, limit: cfg.budget.perSessionYuan, unit: 'currency' }));
  }
  if (cfg.budget.perTurnMs > 0 && tracker.turns.open && tracker.turns.startedAt > 0) {
    const turnMs = now - tracker.turns.startedAt;
    if (turnMs >= cfg.budget.perTurnMs) {
      out.push(verdict('over-budget', SEVERITY.warn,
        `当前 turn 已持续 ${fmtDuration(turnMs)}，超过单 turn 预算 ${fmtDuration(cfg.budget.perTurnMs)}`,
        { turnMs, limit: cfg.budget.perTurnMs, unit: 'turn-ms' }));
    }
  }
  return out;
}

/**
 * Evaluate one tracker. Returns `healthy` explicitly when nothing fired — an
 * empty list would be indistinguishable from "not evaluated".
 */
export function evaluate(tracker, cfg, now) {
  const verdicts = [
    ...spinningVerdicts(tracker, cfg, now),
    ...burningVerdicts(tracker, cfg, now),
    ...repeatingVerdicts(tracker, cfg),
    ...refusingVerdicts(tracker, cfg, now),
    ...budgetVerdicts(tracker, cfg, now),
    ...stalledVerdicts(tracker, cfg, now),
  ];
  if (verdicts.length === 0) {
    verdicts.push(verdict('healthy', SEVERITY.info, '正常', {
      windowTokens: tracker.window.tokens, windowCalls: tracker.window.calls,
      novel: tracker.window.novel, repeatRun: tracker.repeatRun,
    }));
  }
  tracker.verdicts = verdicts;
  return verdicts;
}

/** One-line summary for status/audit. */
export function summarize(verdicts) {
  const worst = verdicts.find((v) => v.severity === 'critical') ?? verdicts.find((v) => v.severity === 'warn') ?? verdicts[0];
  return worst ? `${worst.kind}:${worst.severity}` : 'unknown';
}
