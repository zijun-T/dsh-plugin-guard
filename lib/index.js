/**
 * dsh-guard — a runtime guard for DSH that answers three questions the host
 * itself does not: *is this session stuck*, *is it burning money without
 * producing anything*, and *what did a dead process leave behind*.
 *
 * Scope note (deliberate): this plugin is task-agnostic. It knows nothing about
 * any particular project; it judges work by the only three things it can see
 * from inside the host — spend (tokens), activity (tool calls), and progress
 * (novel outcomes, i.e. results it has not seen before in that session).
 *
 * Safety posture:
 *   - `mode: 'observe'` by default: audit + /status only, zero interference.
 *   - every hook body is wrapped: a guard that throws into the host is a worse
 *     bug than the one it was watching for.
 *   - wall-clock time is never the sole reason for a destructive action.
 *   - the audit log stores counters and digests, not prompts or commands.
 *
 * @module dsh-guard
 */
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolveConfig, MODES } from './defaults.js';
import {
  createTracker, heavyLoad, noteAttempt, noteEvent, noteHeavySettled, noteHumanMessage,
  noteResult, noteTurnEnd, noteTurnStart, noteUsage, tokenTotals,
} from './store.js';
import { evaluate, summarize } from './effort.js';
import { decide, heavyDenyReason, nudgeMessage } from './decisions.js';
import { createLiveness } from './liveness.js';
import { createAudit } from './audit.js';
import {
  bootGeneration, findTeamFiles, readOpenTurns, scanTeams, staleOpenTurns, writeOpenTurns,
} from './selfheal.js';
import { isHeavyCall, totalTokens } from './util.js';

export const name = 'dsh-guard';
/** `tools` is required (the synchronous deny hook); everything else is optional. */
export const inject = ['tools'];

const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'];
const MAX_TRACKERS = 200;
const MAX_BODY_BYTES = 64 * 1024;

function safe(fn, onError) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.then === 'function') return result.catch(onError);
      return result;
    } catch (error) {
      onError(error);
      return undefined;
    }
  };
}

/** Text of a persisted tool-result message, bounded before hashing. */
function resultText(data) {
  const content = data?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object') {
      if (typeof block.text === 'string') parts.push(block.text);
      else if (Array.isArray(block.content)) {
        for (const inner of block.content) if (typeof inner?.text === 'string') parts.push(inner.text);
      } else if (block.value !== undefined) parts.push(JSON.stringify(block.value));
    }
  }
  return parts.join('\n').slice(0, 4000);
}

function looksLikeError(data) {
  const content = data?.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) if (block?.isError === true) return true;
  }
  return false;
}

function parseArgs(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: String(raw) };
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

export function apply(ctx, rawConfig = {}) {
  let cfg;
  try {
    cfg = resolveConfig(rawConfig);
  } catch (error) {
    // Fail loud and register nothing: a guard running on typo'd thresholds
    // would report "healthy" with authority.
    ctx.logger?.error?.(`dsh-guard: 配置无效，插件未启用 —— ${error?.message ?? error}`);
    return;
  }

  const log = (level, message) => {
    try {
      (ctx.logger?.[level] ?? ctx.logger?.info)?.call(ctx.logger, message);
    } catch {
      /* logging must never break the host */
    }
  };
  const onError = (error) => log('warn', `dsh-guard: 内部异常已吞掉以免影响宿主 —— ${error?.message ?? error}`);

  const trackers = new Map();
  const whitelist = new Set(cfg.whitelist);
  let diagnosed = 0;
  const pendingNudges = new Map();
  const pendingReject = new Map();
  const callIndex = new Map();
  const workspaces = new Map();
  const sessionWorkspace = new Map();
  const liveness = createLiveness(cfg.liveness);

  let audit = null;
  let generation = null;
  let booted = false;
  let routesRegistered = false;
  let persistTimer = null;
  let registryTimer = null;
  const pendingPersist = new Set();

  const sessionId = (session) => session?.id ?? session?.sessionId ?? 'unknown';
  const trackerOf = (session) => ensureTracker(sessionId(session), session);

  function ensureTracker(id, session) {
    let tracker = trackers.get(id);
    if (tracker) return tracker;
    tracker = createTracker({ id, label: session?.title ?? session?.label ?? String(id).slice(0, 8), cfg });
    if (trackers.size >= MAX_TRACKERS) {
      const oldest = trackers.keys().next().value;
      if (oldest !== undefined) trackers.delete(oldest);
    }
    trackers.set(id, tracker);
    return tracker;
  }

  /** `$DSH_HOME/guard` — the guard's own root, outside every repository. */
  function guardRoot() {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return resolvePath(cfg.stateRoot.startsWith('/') ? cfg.stateRoot : join(dshHome, cfg.stateRoot));
  }

  const workspaceKey = (path) => createHash('sha1').update(path).digest('hex').slice(0, 10);

  /** Per-workspace state: this workspace's in-flight turns and its scan result. */
  function stateFor(path) {
    const key = workspaceKey(path);
    let state = workspaces.get(key);
    if (!state) {
      state = {
        key, path, dir: join(guardRoot(), 'workspaces', key),
        openTurns: {}, scanned: false, staleTurns: [], teams: [],
      };
      workspaces.set(key, state);
    }
    return state;
  }

  /**
   * The workspace a session belongs to, as the host reports it.
   *
   * The session object is not guaranteed to carry a path (observed live: none of
   * `workspace.path`, `workspacePath`, `cwd` resolved), so this is best-effort
   * only — the workspace **registry** is the authoritative source and binding is
   * driven from it (see `bindFromRegistry`). A session that cannot be resolved is
   * remembered and re-resolved once the registry answers.
   */
  function workspaceOfSession(session) {
    const candidates = [
      session?.workspace?.path,
      session?.workspacePath,
      session?.cwd,
      session?.header?.cwd,             // 实测：会话对象上没有 cwd，但 header.cwd 有
      session?.header?.workspacePath,
      typeof session?.workspace === 'string' ? session.workspace : null,
    ];
    for (const raw of candidates) {
      if (typeof raw === 'string' && raw.startsWith('/')) return raw;
    }
    // A session may carry only a workspace *id*; map it through the registry.
    const id = session?.workspaceId ?? (session?.workspace && typeof session.workspace === 'object' ? session.workspace.id : null);
    if (id !== null && id !== undefined) {
      for (const entry of registryEntries()) {
        if (entry.id === id) return entry.path;
      }
    }
    return null;
  }

  function registryEntries() {
    for (const key of WORKSPACE_KEYS) {
      const registry = ctx.get(key);
      const list = registry?.list?.();
      if (Array.isArray(list)) {
        return list
          .filter((entry) => entry && typeof entry.path === 'string' && entry.path.startsWith('/'))
          .map((entry) => ({ id: entry.id ?? null, path: entry.path, title: entry.title ?? null }));
      }
    }
    return [];
  }

  function registryWorkspaces() {
    return registryEntries().map((entry) => entry.path);
  }

  /**
   * Bind + scan every workspace the registry knows about. Driven from three
   * places because the registry is not ready when the plugin loads:
   * at boot, on every `internal/service` binding, and on a few early retries.
   */
  async function bindFromRegistry() {
    const paths = registryWorkspaces();
    for (const path of paths) {
      const state = stateFor(path);
      if (!state.scanned) await ensureScanned(state);
    }
    // Sessions seen before the registry answered can be resolved now.
    if (paths.length === 1) {
      for (const [id, path] of sessionWorkspace) if (path === null) sessionWorkspace.set(id, paths[0]);
    }
    return paths;
  }

  /**
   * Stale-state scan, run once per workspace at the moment it becomes known.
   *
   * Boot normally happens before the workspace registry exists, so binding state
   * at boot keys it under `process.cwd()` — observed live as the guard writing
   * its generation marker into a directory keyed by `/` while the real
   * workspace (the repo) got a second, audit-less directory, and the team scan
   * silently looked in the wrong place. A session event is the first reliable
   * signal of a real workspace, so binding is deferred to it.
   */
  async function ensureScanned(state) {
    if (state.scanned) return state;
    state.scanned = true;
    const previous = await readOpenTurns(state.dir);
    state.staleTurns = staleOpenTurns(previous, generation?.gen ?? null, Date.now());
    for (const stale of state.staleTurns) {
      await audit?.write({ kind: 'selfheal/stale-turn', workspace: state.path, ...stale });
    }
    await writeOpenTurns(state.dir, {});
    if (cfg.selfheal.enabled && cfg.selfheal.agentTeams !== 'off') {
      try {
        const live = liveSessionIds();
        const files = await findTeamFiles(state.path);
        state.teams = await scanTeams(files, {
          liveSessionIds: live,
          repair: cfg.selfheal.agentTeams === 'repair',
          now: Date.now(),
        });
        for (const team of state.teams) {
          if (team.staleMembers.length === 0) continue;
          await audit?.write({
            kind: team.repaired ? 'selfheal/agent-teams-repaired' : 'selfheal/agent-teams-stale',
            workspace: state.path, team: team.teamId, staleMembers: team.staleMembers,
            staleTasks: team.staleTasks, phase: team.phase, escalated: team.escalated,
          });
        }
      } catch (error) {
        onError(error);
      }
    }
    log('info', `dsh-guard: 工作区建账 ${state.path}（陈旧 turn ${state.staleTurns.length}，团队项 ${state.teams.length}）`);
    return state;
  }

  /** Bind a session to its workspace and make sure that workspace is scanned. */
  function bindWorkspace(session) {
    const id = sessionId(session);
    const path = workspaceOfSession(session);
    if (path === null) {
      if (!sessionWorkspace.has(id)) {
        sessionWorkspace.set(id, null);
        // 诊断：一次性地记录会话对象上"与工作区有关"的字段名，便于定位绑不定
        // 工作区的原因（只记键名与类型，不记任何内容）。
        if (diagnosed < 20) {
          diagnosed += 1;
          void audit?.write({
            kind: 'session/shape', session: id.slice(0, 12),
            keys: Object.keys(session ?? {}).slice(0, 24),
            workspaceType: session?.workspace === undefined ? 'undefined' : typeof session.workspace,
            workspaceKeys: session?.workspace && typeof session.workspace === 'object' ? Object.keys(session.workspace).slice(0, 12) : null,
            cwd: typeof session?.cwd === 'string' ? session.cwd : (typeof session?.header?.cwd === 'string' ? session.header.cwd : null),
            headerKeys: session?.header && typeof session.header === 'object' ? Object.keys(session.header).slice(0, 16) : null,
            registry: registryWorkspaces(),
          });
        }
      }
      return null;
    }
    const state = stateFor(path);
    sessionWorkspace.set(id, path);
    if (!state.scanned) void ensureScanned(state).catch(onError);
    return state;
  }

  function stateOfSession(id) {
    const path = sessionWorkspace.get(id);
    return path === undefined ? null : stateFor(path);
  }

  /**
   * What counts as "live" when deciding whether a member a previous process left
   * `working` is really dead:
   *   1. an agent object that currently exists in-process, and
   *   2. a turn marker written by *this* generation (we wrote it, we own it).
   *
   * Deliberately NOT a session registry listing: a persisted-but-idle session
   * would look live forever and the stale-state report would go silent.
   */
  function liveSessionIds() {
    const out = new Set(trackers.keys());
    const agents = ctx.get('agents');
    const list = agents?.list?.();
    if (Array.isArray(list)) {
      for (const agent of list) {
        const id = sessionId(agent?.session);
        if (id !== 'unknown') out.add(id);
      }
    }
    if (generation) {
      for (const state of workspaces.values()) {
        for (const [id, entry] of Object.entries(state.openTurns)) if (entry?.gen === generation.gen) out.add(id);
      }
    }
    return out;
  }

  /** One-shot process startup: generation marker + audit, then the known workspaces. */
  async function boot() {
    if (booted) return;
    booted = true;
    const root = guardRoot();
    audit = createAudit({
      dir: root, file: cfg.audit.file, maxBytes: cfg.audit.maxBytes,
      includeArguments: cfg.audit.includeArguments, enabled: cfg.audit.enabled,
    });
    generation = await bootGeneration(root, { pid: process.pid, now: Date.now(), mode: cfg.mode });
    await audit.write({
      kind: 'generation/start', gen: generation.gen, pid: process.pid, mode: cfg.mode,
      prevGen: generation.prevGen, prevStartedAt: generation.prevStartedAt, stateRoot: root,
    });
    const known = await bindFromRegistry();
    if (known.length === 0) {
      // 装载早于工作区注册表：短时间内重试，避免"开局不知道工作区就永远不知道"。
      let attempts = 0;
      registryTimer = setInterval(() => {
        attempts += 1;
        void bindFromRegistry()
          .then((paths) => {
            if (paths.length > 0 || attempts >= 30) {
              clearInterval(registryTimer);
              registryTimer = null;
              log('info', `dsh-guard: 工作区注册表就绪（第 ${attempts} 次，${paths.length} 个）`);
            }
          })
          .catch(onError);
      }, 2_000);
      if (typeof registryTimer.unref === 'function') registryTimer.unref();
    }
    log('info', `dsh-guard: 已启动 gen=${generation.gen} mode=${cfg.mode} 已知工作区=${known.length} 状态根=${root}`);
  }

  /** Re-evaluate every tracked session; queue nudges/rejections for the next step. */
  function tick() {
    const now = Date.now();
    for (const [id, tracker] of trackers) {
      if (whitelist.has(id)) continue;
      const verdicts = evaluate(tracker, cfg, now);
      const summary = summarize(verdicts);
      const { events, nudges, reject } = decide({ tracker, cfg, mode: cfg.mode, verdicts, now });
      if (summary !== tracker.lastSummary) {
        tracker.lastSummary = summary;
        void audit?.write({
          kind: 'verdict', session: id, label: tracker.label, summary,
          workspace: sessionWorkspace.get(id) ?? null,
          tokens: tokenTotals(tracker), yuan: Number(tracker.usage.yuan.toFixed(4)),
          toolCalls: tracker.attempts, novel: tracker.novel, verdicts: events,
        });
      }
      for (const nudge of nudges) queueNudge(id, nudge);
      if (reject) {
        pendingReject.set(id, reject);
        void audit?.write({ kind: 'action/reject-armed', session: id, ...reject });
      }
    }
  }

  function queueNudge(id, nudge) {
    if (cfg.mode === 'observe') return;
    const list = pendingNudges.get(id) ?? [];
    list.push(nudge);
    pendingNudges.set(id, list.slice(-3));
    void audit?.write({ kind: 'action/nudge', session: id, verdict: nudge.kind, severity: nudge.severity });
  }

  /** Live snapshot used by both /status and the audit's periodic summary. */
  function statusSnapshot() {
    const now = Date.now();
    const sessions = [];
    for (const [id, tracker] of trackers) {
      sessions.push({
        session: id,
        label: tracker.label,
        whitelisted: whitelist.has(id),
        tokens: tokenTotals(tracker),
        yuan: Number(tracker.usage.yuan.toFixed(4)),
        toolCalls: tracker.attempts,
        novel: tracker.novel,
        repeatRun: tracker.repeatRun,
        identicalOutcomeRun: tracker.sameOutcomeRun,
        turnOpen: tracker.turns.open === 1,
        currentTurn: tracker.turns.current,
        idleMs: now - tracker.lastEventAt,
        lastProgressAgoMs: tracker.lastArtifactAt || tracker.lastLedgerAt
          ? now - Math.max(tracker.lastArtifactAt, tracker.lastLedgerAt) : null,
        heavy: heavyLoad(tracker, cfg, now),
        verdict: summarize(tracker.verdicts ?? []),
        verdicts: (tracker.verdicts ?? []).map((v) => ({ kind: v.kind, severity: v.severity, text: v.text, evidence: v.evidence })),
      });
    }
    sessions.sort((a, b) => b.tokens - a.tokens);
    return {
      plugin: name,
      mode: cfg.mode,
      generation: generation ? { gen: generation.gen, startedAt: generation.startedAt, prevGen: generation.prevGen } : null,
      thresholds: {
        idleWindowMs: cfg.idle.windowMs, idleMinTokens: cfg.idle.minTokens, idleMinToolCalls: cfg.idle.minToolCalls,
        repeatsWarn: cfg.repeats.warn, repeatsCritical: cfg.repeats.critical, refusalsLimit: cfg.refusals.limit,
        heavyTimeoutMs: cfg.heavy.timeoutMs, heavyMaxConcurrent: cfg.heavy.maxConcurrent, heavyMaxPer10Min: cfg.heavy.maxPer10Min,
        budgetTokens: cfg.budget.perSessionTokens, budgetYuan: cfg.budget.perSessionYuan, budgetOnExceed: cfg.budget.onExceed,
        suspectMs: cfg.heartbeat.suspectMs, parkMs: cfg.heartbeat.parkMs,
        nudgeRejectAfter: cfg.nudge.rejectAfterNudges,
      },
      liveness: liveness.stats(),
      totals: sessions.reduce((acc, s) => ({ tokens: acc.tokens + s.tokens, yuan: Number((acc.yuan + s.yuan).toFixed(4)), sessions: acc.sessions + 1 }), { tokens: 0, yuan: 0, sessions: 0 }),
      sessions,
      workspaces: [...workspaces.values()].map((state) => ({
        key: state.key, path: state.path, scanned: state.scanned,
        openTurns: Object.keys(state.openTurns).length,
        staleTurns: state.staleTurns,
        teams: state.teams.map((team) => ({
          teamId: team.teamId, phase: team.phase, escalated: team.escalated,
          staleMembers: team.staleMembers, staleTasks: team.staleTasks, repaired: team.repaired,
        })),
      })),
      registry: registryEntries(),
      staleTurns: [...workspaces.values()].flatMap((state) => state.staleTurns.map((s) => ({ ...s, workspace: state.path }))),
      teams: [...workspaces.values()].flatMap((state) => state.teams),
      audit: audit?.stats() ?? null,
      now,
    };
  }

  async function readBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        if (tooBig) return;
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) {
          tooBig = true;
          raw = '';
        }
      });
      req.on('end', () => {
        if (tooBig) return resolve(null);
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  function registerRoutes() {
    if (routesRegistered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    routesRegistered = true;
    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-guard/status',
      handler: (_req, res) => json(res, 200, safe(statusSnapshot, onError)() ?? { error: 'snapshot failed' }),
    }), 'dsh-guard: status route');
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-guard/audit',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
        json(res, 200, { records: (await audit?.tail(limit)) ?? [] });
      },
    }), 'dsh-guard: audit route');
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-guard/action',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        const body = await readBody(req);
        if (body === null) return json(res, 400, { ok: false, error: 'invalid JSON body' });
        const action = String(body.action ?? '');
        const session = body.session === undefined ? null : String(body.session);
        if (action === 'whitelist' || action === 'unwhitelist') {
          if (!session) return json(res, 400, { ok: false, error: 'session is required' });
          if (action === 'whitelist') whitelist.add(session); else whitelist.delete(session);
          void audit?.write({ kind: 'action/whitelist', session, on: action === 'whitelist' });
          return json(res, 200, { ok: true, whitelist: [...whitelist] });
        }
        if (action === 'mode') {
          const next = String(body.mode ?? '');
          if (!MODES.includes(next)) return json(res, 400, { ok: false, error: `mode must be one of ${MODES.join('|')}` });
          cfg.mode = next;
          void audit?.write({ kind: 'action/mode', mode: next });
          return json(res, 200, { ok: true, mode: next });
        }
        if (action === 'clear') {
          const tracker = session ? trackers.get(session) : null;
          if (tracker) {
            tracker.nudges.clear();
            tracker.verdicts = [];
            tracker.lastSummary = '';
          }
          if (session) pendingReject.delete(session);
          void audit?.write({ kind: 'action/clear', session });
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { ok: false, error: 'unknown action' });
      },
    }), 'dsh-guard: action route');
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-guard/health',
      handler: (_req, res) => json(res, 200, { ok: true, mode: cfg.mode, gen: generation?.gen ?? null, lag: liveness.stats().lastMs }),
    }), 'dsh-guard: health route');
    void audit?.write({ kind: 'boot/routes', paths: ['status', 'audit', 'action', 'health'] });
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  ctx.effect(() => {
    void boot().catch(onError);
    liveness.start();
    const timer = setInterval(safe(tick, onError), cfg.tickMs);
    if (typeof timer.unref === 'function') timer.unref();
    registerRoutes();
    return () => {
      liveness.stop();
      clearInterval(timer);
      if (persistTimer) clearTimeout(persistTimer);
      if (registryTimer) clearInterval(registryTimer);
      for (const state of workspaces.values()) void writeOpenTurns(state.dir, state.openTurns);
      void audit?.write({ kind: 'generation/stop', gen: generation?.gen ?? null, workspaces: workspaces.size });
    };
  }, 'dsh-guard: timers + boot');

  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName) || WORKSPACE_KEYS.includes(serviceName)) {
      safe(() => {
        registerRoutes();
        if (!booted) void boot().catch(onError);
        else void bindFromRegistry().catch(onError);
      }, onError)();
    }
  });

  ctx.on('session/event', safe((session, event) => {
    const id = sessionId(session);
    const tracker = trackerOf(session);
    const state = bindWorkspace(session);
    const at = typeof event?.time === 'number' ? event.time : Date.now();
    const data = event?.data ?? {};
    noteEvent(tracker, at);
    switch (event?.type) {
      case 'user/message':
        if (data.source?.kind === 'user') noteHumanMessage(tracker, at);
        break;
      case 'turn/start':
        noteTurnStart(tracker, data.turn, at);
        if (state) {
          state.openTurns[id] = { turn: data.turn ?? null, gen: generation?.gen ?? null, since: at };
          persistOpenTurns(state);
        }
        break;
      case 'turn/end':
        noteTurnEnd(tracker, data.reason, at);
        if (state) {
          delete state.openTurns[id];
          persistOpenTurns(state);
        }
        break;
      case 'tool/call': {
        const tool = String(data.name ?? 'unknown');
        const args = parseArgs(data.arguments);
        noteAttempt(tracker, { tool, args, at, cfg, callId: data.callId });
        if (data.callId !== undefined) callIndex.set(data.callId, { id, tool, args, at });
        break;
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId ?? data.callId;
        const known = callId === undefined ? undefined : callIndex.get(callId);
        const tool = known?.tool ?? String(data.name ?? 'unknown');
        noteResult(tracker, {
          tool, args: known?.args, outcome: resultText(data),
          isError: looksLikeError(data), at, cfg,
        });
        noteHeavySettled(tracker, { callId, at });
        if (callId !== undefined) callIndex.delete(callId);
        break;
      }
      case 'assistant/chunk': {
        const usage = data.chunk?.usage;
        if (usage) noteUsage(tracker, usage, at, cfg);
        break;
      }
      default:
        break;
    }
  }, onError));

  /**
   * The one interception point that can rewrite this step or refuse it.
   * `reject` ends the turn as `blocked` — a first-class terminal state, not a
   * hang — and is only ever armed by the tick loop under `enforce`.
   */
  ctx.on('agent/pre-step', async (payload, next) => {
    // The decision this waterfall returns must ALWAYS be a valid PreStepDecision
    // ({kind:'enter', messages} | {kind:'reject'}). Returning undefined after a
    // throw would be worse than not having a guard at all, so the pre-next work
    // is isolated and the post-next surgery falls back to the untouched decision.
    let id = 'unknown';
    try {
      id = sessionId(payload?.agent?.session);
      if (whitelist.has(id)) return await next();
      const armed = pendingReject.get(id);
      if (armed) {
        pendingReject.delete(id);
        void audit?.write({ kind: 'action/rejected-step', session: id, ...armed });
        return { kind: 'reject' };
      }
    } catch (error) {
      onError(error);
    }
    const downstream = await next();
    try {
      const queued = pendingNudges.get(id);
      if (!queued || queued.length === 0) return downstream;
      if (downstream?.kind !== 'enter' || !Array.isArray(downstream.messages)) return downstream;
      pendingNudges.delete(id);
      const notices = queued.map((nudge) => nudgeMessage(nudge, nudge.text, { plugin: cfg.noticePlugin }));
      return { ...downstream, messages: [...notices, ...downstream.messages] };
    } catch (error) {
      onError(error);
      return downstream;
    }
  });

  /**
   * Synchronous hard limits. `tools.guard` denies by returning a reason string;
   * this is the only place the guard can stop work *before* it is spent.
   */
  ctx.effect(() => ctx.tools.guard((exec) => {
    try {
      if (!exec || exec.agent === undefined) return undefined;
      // observe/advise 一律不拒绝任何调用：只有 enforce 才允许硬闸。
      // （线上实测过这个洞：observe 模式下仍拒了一次 core-dev 的 bash，
      //   与"装上不改变任何行为"的承诺相矛盾。）
      if (cfg.mode !== 'enforce') return undefined;
      const id = sessionId(exec.agent.session);
      if (whitelist.has(id)) return undefined;
      const tracker = trackers.get(id);
      if (!tracker) return undefined;
      const now = Date.now();
      const load = heavyLoad(tracker, cfg, now, exec.callId);
      if (isHeavyCall(String(exec.name), exec.arguments ?? {}, cfg)) {
        const reason = heavyDenyReason(tracker, cfg, now, load);
        if (reason) {
          void audit?.write({ kind: 'action/denied-heavy', session: id, tool: exec.name, load });
          return reason;
        }
      }
      if (cfg.budget.onExceed === 'deny-heavy' && cfg.budget.perSessionTokens > 0
        && totalTokens(tracker.usage) >= cfg.budget.perSessionTokens) {
        void audit?.write({ kind: 'action/denied-budget', session: id, tool: exec.name });
        return 'dsh-guard: 本会话 token 预算已用尽，重量级调用已被限制；请收尾并汇报';
      }
      return undefined;
    } catch (error) {
      onError(error);
      return undefined;
    }
  }), 'dsh-guard: heavy/budget guard');

  log('info', `dsh-guard: 已装载（mode=${cfg.mode}，tick=${cfg.tickMs}ms，状态根 ${guardRoot()}）`);
}
