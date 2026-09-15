/**
 * The action layer: verdicts in, graded actions out.
 *
 * Ladder (never skipped, never silent):
 *   observe  → audit + /status only
 *   advise   → + one nudge message per verdict kind per cooldown
 *   enforce  → + reject the step / deny heavy tools, and only after the nudge
 *              was already ignored `nudge.rejectAfterNudges` times
 *
 * `stalled` is deliberately not rejectable: a silent session is usually a long
 * command or a provider retry, and rejecting it would destroy real work.
 */
import { fmtDuration, fmtTokens } from './util.js';

const ESCAPE = '若这是合法的长任务，请忽略本提示并继续；人可在 /plugins/dsh-guard/status 里把本会话加入白名单。';

/** Verdict kinds that never produce a nudge on their own. */
const QUIET = new Set(['healthy', 'polling']);

function nudgeText(verdict) {
  switch (verdict.kind) {
    case 'spinning':
      return `【dsh-guard】检测到空转：最近 ${fmtDuration(verdict.evidence.silentForMs ?? 0)} 没有任何新产物或台账推进，却已花掉 ${fmtTokens(verdict.evidence.windowTokens ?? 0)} tokens / ${verdict.evidence.windowCalls ?? 0} 次工具调用。`
        + `请立刻停止重复动作，用一两句话汇报你已确认的结论、当前阻塞点和下一步唯一动作，不要继续重试。${ESCAPE}`;
    case 'repeating':
      return `【dsh-guard】检测到原地重复：你已经连续 ${verdict.evidence.run} 次用完全相同的参数调用 \`${verdict.evidence.tool}\`，并且拿到了完全相同的结果。`
        + `请先读一遍上一次的结果再决定：换参数、换方法，或者直接收尾汇报。${ESCAPE}`;
    case 'refusing':
      return `【dsh-guard】检测到无效重试：\`${verdict.evidence.tool}\` 已经连续被拒绝 ${verdict.evidence.count} 次，继续重试不会改变结果。`
        + `请停下来，把这件事作为阻塞点上报（谁需要先做什么才能解锁），或者改做别的可推进的工作。`;
    case 'burning':
      return `【dsh-guard】检测到只花钱不动手：最近 ${fmtDuration(verdict.evidence.window)} 花了约 ${fmtTokens(verdict.evidence.windowTokens)} tokens，但几乎没有工具活动（${verdict.evidence.windowCalls} 次）。`
        + `如果你在反复自我推演而没有新信息，请改用一次工具调用验证假设，或直接给出当前最优答复。${ESCAPE}`;
    case 'over-budget':
      return `【dsh-guard】预算已超：${verdict.text}。请立即收尾并给出结论，后续动作需要人确认。`;
    case 'stalled':
      return `【dsh-guard】本会话已停滞 ${fmtDuration(verdict.evidence.idleMs)}（turn ${verdict.evidence.turn} 仍开启）。可能只是长命令或网络重试，故不打断；若你其实已经完成，请收尾。`;
    default:
      return `【dsh-guard】${verdict.text}`;
  }
}

/** One message object in the transcript's own shape (see dsh-llm createUserMessage). */
export function nudgeMessage(verdict, text, { plugin = 'dsh-guard', id } = {}) {
  return {
    id: id ?? (globalThis.crypto?.randomUUID?.() ?? `guard-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'notice', summary: `guard:${verdict.kind}` },
  };
}

/**
 * Decide what to do about one tracker's verdicts. Pure: the caller owns the
 * clock, the mode, and the side effects (injection / rejection / denial).
 */
export function decide({ tracker, cfg, mode, verdicts, now }) {
  const events = [];
  const nudges = [];
  let reject = null;
  let denyHeavy = null;

  for (const verdict of verdicts) {
    if (verdict.kind === 'healthy') continue;
    events.push({ kind: verdict.kind, severity: verdict.severity, text: verdict.text, evidence: verdict.evidence });

    if (mode === 'observe') continue;
    if (QUIET.has(verdict.kind) && verdict.severity === 'info') continue;

    const budgetHard = verdict.kind === 'over-budget'
      && (cfg.budget.onExceed === 'reject' || cfg.budget.onExceed === 'deny-heavy');

    // Nudge throttle: one notice per kind per cooldown, then count it.
    const state = tracker.nudges.get(verdict.kind) ?? { count: 0, at: 0 };
    const cooled = now - state.at >= cfg.nudge.cooldownMs;
    if (cooled) {
      nudges.push({ kind: verdict.kind, severity: verdict.severity, text: nudgeText(verdict) });
      tracker.nudges.set(verdict.kind, { count: state.count + 1, at: now });
    }
    const nudgeCount = tracker.nudges.get(verdict.kind)?.count ?? 0;

    if (budgetHard) {
      if (cfg.budget.onExceed === 'deny-heavy') denyHeavy = `dsh-guard: 会话已超预算（${verdict.text}）——重量级工具已被限制`;
      else reject = { kind: verdict.kind, reason: `dsh-guard: 会话已超预算（${verdict.text}），已阻止继续执行` };
      continue;
    }
    if (mode !== 'enforce') continue;
    if (!cfg.nudge.rejectable.includes(verdict.kind)) continue;
    if (nudgeCount < cfg.nudge.rejectAfterNudges) continue;
    reject = {
      kind: verdict.kind,
      reason: `dsh-guard: 已提示 ${nudgeCount} 次仍未改变（${verdict.kind}：${verdict.text}），按配置阻止本步继续`,
    };
  }

  return { events, nudges, reject, denyHeavy };
}

/**
 * Reason string for the synchronous `tools.guard` (heavy-call limits).
 *
 * Both comparisons are `>=`, not `>`: the caller's own call is already excluded
 * from `inFlight`, so "one other heavy call running" with a limit of 1 must
 * refuse this one. Counters are compared the same way — the limit is "at most N",
 * so the (N+1)-th heavy call is the one to refuse.
 */
export function heavyDenyReason(tracker, cfg, now, load) {
  if (load.inFlight >= cfg.heavy.maxConcurrent) {
    return `dsh-guard: 本会话已有 ${load.inFlight} 个重量级调用在跑（上限 ${cfg.heavy.maxConcurrent}）——请先等它结束，避免并发把机器拖垮`;
  }
  if (load.last10min >= cfg.heavy.maxPer10Min) {
    return `dsh-guard: 最近 10 分钟已发起 ${load.last10min} 次重量级调用（上限 ${cfg.heavy.maxPer10Min}）——请复用已有沙箱/产物，而不是再起一份`;
  }
  return null;
}

/**
 * 宿主级并发闸：同时进行的重量级调用超过 hostMaxConcurrent 就拒绝。
 * （单会话闸管"别自己叠"，这道管"别六个人一起开工"。）
 */
export function hostHeavyDenyReason(hostInFlight, cfg) {
  if (hostInFlight >= cfg.heavy.hostMaxConcurrent) {
    return `dsh-guard: 宿主上已有 ${hostInFlight} 个重量级任务在跑（上限 ${cfg.heavy.hostMaxConcurrent}）——`
      + '并发重活会把单事件循环压死、界面卡住；请等它们结束再开工';
  }
  return null;
}

/**
 * 泄压闸：事件循环已经滞后到阈值以上时，先停止加新压力（纯函数，便于测试）。
 */
export function shedHeavyReason(lagMs, cfg) {
  if (!(lagMs >= cfg.liveness.shedHeavyAboveMs)) return null;
  return `dsh-guard: 宿主事件循环已滞后 ${Math.round(lagMs)}ms（阈值 ${cfg.liveness.shedHeavyAboveMs}ms）——`
    + '疑似界面正要卡死，暂不接受新的重量级调用，请稍后重试或改做轻量工作';
}
