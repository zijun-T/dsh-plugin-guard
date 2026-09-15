/**
 * dsh-guard defaults — the single source of every threshold this plugin ships.
 *
 * Every number below is either (a) measured against this host's own history, or
 * (b) deliberately "off". A threshold that cannot be defended with evidence is
 * not allowed to take a destructive action: see `resolveConfig` (fail-loud) and
 * `mode` (observe → advise → enforce).
 *
 * Measured evidence used to calibrate (4675 tool calls + 7 sessions, 15h):
 *   - tool-call wall clock: p50 4.9s / p90 36.7s / p99 123s / max 295s
 *     ⇒ heavy-tool hard cap 600s has ZERO false positives in that history.
 *   - consecutive identical tool calls: legal maximum observed = 3
 *     ⇒ warn at 5, critical at 10 (the core already nudges at 3/5/8).
 *   - same-task claim retried after a terminal rejection: up to 6 times
 *     ⇒ 3 is already abnormal.
 *   - one exchange-unreachable instance retried 180 times in 19 min with no
 *     backoff ⇒ repetition counting is the right tool, wall time is not.
 *   - 7 sessions stalled ~900s simultaneously (LLM transport retries)
 *     ⇒ wall time must NEVER be used to call something an infinite loop.
 */

/** Escalation ladder. Nothing destructive happens in `observe`. */
export const MODES = ['observe', 'advise', 'enforce'];

/**
 * Tools that are heavy no matter what they are asked to do: each one can spawn
 * a worker fleet, and two at once is what dragged this host down.
 */
export const DEFAULT_HEAVY_TOOLS = [
  'workflow', 'ralph', 'subagent', 'subagent_fork',
  'agent_teams_create', 'agent_teams_approve',
];

/** Shell tools that are heavy only when the command looks like a whole suite. */
export const DEFAULT_SUITE_TOOLS = ['bash', 'pwsh', 'run_code'];

/**
 * Measured trigger: 12 full-repo clones + 5 whole-suite runs inside 36 minutes,
 * several concurrently. Ordinary `ls`/`grep`/`cat` never match.
 */
export const DEFAULT_SUITE_PATTERN = [
  'git clone', 'git worktree add', 'run_regression_battery', 'run_pytestless',
  '--allow-panel', 'pytest', 'pnpm (test|run)', 'npm (test|run)', 'docker build',
  'bundle install', 'cargo build', 'make -j',
].join('|');

/** Tools whose *novel* result counts as an artifact (the workspace really moved). */
export const DEFAULT_ARTIFACT_TOOLS = [
  'write', 'edit', 'str_replace', 'str_replace_editor', 'apply_patch',
  'bash', 'pwsh', 'run_code', 'code',
];

/** Tools whose *novel* result counts as ledger progress (plan/state really moved). */
export const DEFAULT_LEDGER_TOOLS = [
  'todo_write', 'create_goal', 'update_goal',
  'agent_teams_create_task', 'agent_teams_update_task', 'agent_teams_claim_task',
];

export const DEFAULTS = {
  /** observe = audit+status only · advise = + nudge messages · enforce = + deny/reject */
  mode: 'observe',

  /**
   * Where this plugin keeps its own state. Relative paths resolve under
   * `$DSH_HOME` (default `~/.dsh`) and always get a per-workspace subdirectory,
   * so the guard NEVER writes inside a user's repository.
   */
  stateRoot: 'guard',

  /** Identity of the plugin's injected notices in the transcript. */
  noticePlugin: 'dsh-guard',

  idle: {
    /** Rolling window used to decide "spent a lot, moved nothing". */
    windowMs: 600_000,
    /** Tokens (input+output+cacheRead) inside the window that make silence suspicious. */
    minTokens: 20_000,
    /** Tool calls inside the window required before silence counts as spinning. */
    minToolCalls: 8,
    /** Never judge a session this soon after it started or after a human message. */
    graceMs: 180_000,
  },

  /**
   * Opt-in: tokens spent with almost no tool activity at all. Off by default
   * (minTokens 0) because a pure-reasoning task legitimately looks like this;
   * turn it on when your workflow is tool-driven and you want the "model is
   * thinking in circles forever" shape covered too.
   */
  burn: {
    windowMs: 600_000,
    minTokens: 0,
    /** Calls at or below this count inside the window mean "essentially no work". */
    maxToolCalls: 2,
  },

  repeats: {
    /** Consecutive identical (tool, canonical args) calls. */
    warn: 5,
    /** Measured legal maximum in this host's history is 3. */
    critical: 10,
  },

  /** How many times a refusal to do work may repeat before it is escalated. */
  refusals: { limit: 3 },

  heavy: {
    tools: DEFAULT_HEAVY_TOOLS,
    suiteTools: DEFAULT_SUITE_TOOLS,
    suitePattern: DEFAULT_SUITE_PATTERN,
    /** Advisory cap published to /status; enforced by the host timeout policy. */
    timeoutMs: 600_000,
    /** Concurrent heavy calls per session. */
    maxConcurrent: 1,
    /**
     * Heavy calls per rolling 10 minutes per session.
     * 3 was too tight for real work on this host (实测：36 分钟内 5 次全量电池 +
     * 12 次整仓克隆都属正常节奏) ⇒ 默认放宽到 10，只拦"明显失控"的那种。
     */
    maxPer10Min: 10,
  },

  progress: {
    artifactTools: DEFAULT_ARTIFACT_TOOLS,
    ledgerTools: DEFAULT_LEDGER_TOOLS,
    /** Distinct (tool,args,outcome) triples retained per session. */
    seenCap: 2_000,
  },

  budget: {
    /** 0 = off. Tokens are counted as input+output+cacheRead+reasoning. */
    perSessionTokens: 0,
    perTurnMs: 0,
    /** 0 = off; only usable when `pricing` is filled in (currency units per 1e6). */
    perSessionYuan: 0,
    /** e.g. { 'deepseek-official': { input: 2, output: 8, cacheRead: 0.5 } } */
    pricing: {},
    /** notify | deny-heavy | reject | downgrade */
    onExceed: 'notify',
    /** Required by `downgrade`; unset = downgrade disabled. */
    downgradeModel: '',
  },

  heartbeat: {
    /** No session event for this long while a turn is open ⇒ `stalled` (never rejected). */
    suspectMs: 600_000,
    /** Stalled this long ⇒ also surfaced as `parked` in status/audit. */
    parkMs: 1_800_000,
  },

  /** Nudge throttling: at most one notice per verdict kind per session per cooldown. */
  nudge: {
    cooldownMs: 120_000,
    /** In enforce mode, this many ignored nudges escalate to a step reject. */
    rejectAfterNudges: 2,
    /** Verdict kinds that may ever be rejected. `stalled` is deliberately absent. */
    rejectable: ['repeating', 'spinning', 'over-budget'],
  },

  /** How often verdicts are re-evaluated (and /status refreshed). */
  tickMs: 5_000,

  audit: {
    enabled: true,
    file: 'audit.jsonl',
    maxBytes: 8 * 1024 * 1024,
    /** Keep raw tool arguments/commands out of the audit by default. */
    includeArguments: false,
  },

  liveness: {
    sampleMs: 1_000,
    keep: 120,
    /** Event-loop lag thresholds (the exact failure that froze the Web UI). */
    lagWarnMs: 500,
    lagCriticalMs: 2_000,
  },

  selfheal: {
    enabled: true,
    /** off | report | repair — repair only ever flips stale members back to idle. */
    agentTeams: 'report',
  },

  /** Sessions exempt from every action (human-marked legitimate long runs). */
  whitelist: [],
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge of a user patch over the defaults (arrays replace, never merge). */
export function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeConfig(base[key], value) : value;
  }
  return out;
}

function assertPositiveNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`dsh-guard: ${path} must be a non-negative finite number, got ${JSON.stringify(value)}`);
  }
}

/**
 * Validate + normalize one configuration patch. Fail-loud on nonsense rather
 * than silently clamping: a guard whose own thresholds are typo'd is worse
 * than no guard, because it reports "healthy".
 */
export function resolveConfig(patch = {}) {
  const cfg = mergeConfig(DEFAULTS, patch);
  if (!MODES.includes(cfg.mode)) {
    throw new Error(`dsh-guard: mode must be one of ${MODES.join('|')}, got ${JSON.stringify(cfg.mode)}`);
  }
  const numeric = [
    ['idle.windowMs', cfg.idle.windowMs], ['idle.minTokens', cfg.idle.minTokens],
    ['idle.minToolCalls', cfg.idle.minToolCalls], ['idle.graceMs', cfg.idle.graceMs],
    ['burn.windowMs', cfg.burn.windowMs], ['burn.minTokens', cfg.burn.minTokens],
    ['burn.maxToolCalls', cfg.burn.maxToolCalls],
    ['repeats.warn', cfg.repeats.warn], ['repeats.critical', cfg.repeats.critical],
    ['refusals.limit', cfg.refusals.limit],
    ['heavy.timeoutMs', cfg.heavy.timeoutMs], ['heavy.maxConcurrent', cfg.heavy.maxConcurrent],
    ['heavy.maxPer10Min', cfg.heavy.maxPer10Min],
    ['budget.perSessionTokens', cfg.budget.perSessionTokens], ['budget.perTurnMs', cfg.budget.perTurnMs],
    ['budget.perSessionYuan', cfg.budget.perSessionYuan],
    ['heartbeat.suspectMs', cfg.heartbeat.suspectMs], ['heartbeat.parkMs', cfg.heartbeat.parkMs],
    ['nudge.cooldownMs', cfg.nudge.cooldownMs], ['nudge.rejectAfterNudges', cfg.nudge.rejectAfterNudges],
    ['tickMs', cfg.tickMs],
    ['liveness.sampleMs', cfg.liveness.sampleMs], ['liveness.keep', cfg.liveness.keep],
    ['liveness.lagWarnMs', cfg.liveness.lagWarnMs], ['liveness.lagCriticalMs', cfg.liveness.lagCriticalMs],
  ];
  for (const [path, value] of numeric) assertPositiveNumber(value, path);
  if (cfg.repeats.warn >= cfg.repeats.critical) {
    throw new Error(`dsh-guard: repeats.warn (${cfg.repeats.warn}) must be < repeats.critical (${cfg.repeats.critical})`);
  }
  if (cfg.liveness.lagWarnMs >= cfg.liveness.lagCriticalMs) {
    throw new Error('dsh-guard: liveness.lagWarnMs must be < lagCriticalMs');
  }
  if (!Array.isArray(cfg.whitelist)) throw new Error('dsh-guard: whitelist must be an array of session ids');
  if (!['notify', 'deny-heavy', 'reject', 'downgrade'].includes(cfg.budget.onExceed)) {
    throw new Error(`dsh-guard: budget.onExceed must be notify|deny-heavy|reject|downgrade, got ${JSON.stringify(cfg.budget.onExceed)}`);
  }
  if (!['off', 'report', 'repair'].includes(cfg.selfheal.agentTeams)) {
    throw new Error(`dsh-guard: selfheal.agentTeams must be off|report|repair, got ${JSON.stringify(cfg.selfheal.agentTeams)}`);
  }
  if (cfg.budget.onExceed === 'downgrade' && !cfg.budget.downgradeModel) {
    throw new Error('dsh-guard: budget.onExceed=downgrade requires budget.downgradeModel');
  }
  return cfg;
}
