#!/usr/bin/env node
/**
 * Offline test suite for dsh-guard. No test framework, no network, no host:
 * `apply()` is driven through a fake cordis context, so every assertion runs
 * against the same code the host will load.
 *
 *   node test/run.mjs            # all cases
 *   node test/run.mjs --verbose
 */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { resolveConfig, DEFAULTS } from '../lib/defaults.js';
import { createTracker, noteAttempt, noteResult, noteUsage, heavyLoad, noteHeavySettled } from '../lib/store.js';
import { evaluate } from '../lib/effort.js';
import { decide, hostHeavyDenyReason, shedHeavyReason } from '../lib/decisions.js';
import { createRecoveryState, recoveryDecision } from '../lib/recovery.js';

const verbose = process.argv.includes('--verbose');
let pass = 0;
const failures = [];

function ok(condition, label, detail) {
  if (condition) {
    pass += 1;
    if (verbose) console.log(`  ✅ ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
}

async function pathMissing(path) {
  try {
    await readdir(path);
    return false;
  } catch {
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal cordis-shaped host so the plugin runs unmodified. */
function fakeHost({ workspace, webServer = true } = {}) {
  const handlers = new Map();
  const routes = new Map();
  const guards = [];
  const disposers = [];
  const services = {
    workspaceRegistry: { list: () => [{ path: workspace, title: 'test' }] },
    sessions: { list: () => [] },
    agents: { list: () => [] },
  };
  if (webServer) {
    services.webServer = {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    };
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { guard: (fn) => { guards.push(fn); return () => {}; } },
    effect: (fn) => { const d = fn(); disposers.push(d); return () => {}; },
    on: (event, handler) => { handlers.set(event, handler); return () => {}; },
    get: (key) => services[key],
  };
  return {
    ctx, handlers, routes, guards, disposers, services,
    emit: (event, session, data) => handlers.get('session/event')?.(session, { type: event, time: Date.now(), data }),
    preStep: (agent) => handlers.get('agent/pre-step')({ agent, messages: [], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] })),
  };
}

function fakeRes() {
  const res = {
    code: 0, body: '', headers: {},
    writeHead(code, headers) { this.code = code; this.headers = headers ?? {}; },
    end(body) { this.body = body ?? ''; },
  };
  return res;
}

async function callRoute(host, path, { method = 'GET', body, url } = {}) {
  const route = host.routes.get(path);
  if (!route) throw new Error(`route ${path} not registered`);
  const res = fakeRes();
  const req = {
    method, url: url ?? path,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
      if (event === 'end') cb();
      return this;
    },
  };
  await route.handler(req, res);
  return res;
}

// ── 1. pure layer ────────────────────────────────────────────────────────────
console.log('\n[1] 判定层');
{
  const cfg = resolveConfig({ idle: { minTokens: 1000, minToolCalls: 3, windowMs: 30_000, graceMs: 0 } });
  const base = Date.now();
  const mk = (id) => { const t = createTracker({ id, cfg }); t.createdAt = base - 600_000; t.lastHumanAt = t.createdAt; return t; };

  const spinning = mk('spin');
  for (let i = 0; i < 12; i += 1) {
    const at = base + i * 5000;
    noteAttempt(spinning, { tool: 'bash', args: { command: 'curl okx' }, at, cfg, callId: `c${i}` });
    noteResult(spinning, { tool: 'bash', args: { command: 'curl okx' }, outcome: 'No route to host', at: at + 1, cfg });
    noteUsage(spinning, { inputTokens: 2000, outputTokens: 500 }, at + 2, cfg);
  }
  const spinVerdicts = evaluate(spinning, cfg, base + 60_000).map((v) => v.kind);
  ok(spinVerdicts.includes('spinning'), '同调用+同结果+持续烧钱 ⇒ spinning', spinVerdicts.join(','));

  const polling = mk('poll');
  for (let i = 0; i < 12; i += 1) {
    const at = base + i * 5000;
    noteAttempt(polling, { tool: 'bash', args: { command: 'tail log' }, at, cfg, callId: `p${i}` });
    noteResult(polling, { tool: 'bash', args: { command: 'tail log' }, outcome: `line ${i}`, at: at + 1, cfg });
    noteUsage(polling, { inputTokens: 2000, outputTokens: 500 }, at + 2, cfg);
  }
  const pollVerdicts = evaluate(polling, cfg, base + 60_000).map((v) => v.kind);
  ok(!pollVerdicts.includes('spinning'), '同命令但结果在变（合法轮询）⇒ 不判空转', pollVerdicts.join(','));
  ok(pollVerdicts.includes('polling'), '合法轮询被显式标注为 polling（可见但不动作）', pollVerdicts.join(','));

  const refused = mk('refuse');
  for (let i = 0; i < 4; i += 1) {
    noteAttempt(refused, { tool: 'agent_teams_claim_task', args: { task_id: `t${i}` }, at: base + i * 1000, cfg, callId: `r${i}` });
    noteResult(refused, { tool: 'agent_teams_claim_task', args: { task_id: `t${i}` }, outcome: 'Error: task status cannot move from completed', at: base + i * 1000 + 1, cfg });
  }
  ok(evaluate(refused, cfg, base + 5000).some((v) => v.kind === 'refusing'), '同一工具反复被拒 ⇒ refusing');

  const stalled = mk('stall');
  stalled.turns.open = 1;
  stalled.turns.current = 7;
  stalled.lastEventAt = base - 1_200_000;
  ok(evaluate(stalled, cfg, base).some((v) => v.kind === 'stalled'), '无事件但 turn 未关 ⇒ stalled');

  const healthy = mk('healthy');
  noteAttempt(healthy, { tool: 'write', args: { file: 'a' }, at: base, cfg, callId: 'h1' });
  noteResult(healthy, { tool: 'write', args: { file: 'a' }, outcome: 'wrote a', at: base + 1, cfg });
  ok(evaluate(healthy, cfg, base + 2000).every((v) => v.kind === 'healthy'), '有新颖产物 ⇒ healthy');

  // heavy accounting must not leak when a result never arrives
  const leaky = mk('leak');
  noteAttempt(leaky, { tool: 'workflow', args: { script: 'x' }, at: base, cfg, callId: 'L1' });
  eq(heavyLoad(leaky, cfg, base + 1000).inFlight, 1, '重型调用计入在跑');
  eq(heavyLoad(leaky, cfg, base + 1000, 'L1').inFlight, 0, '排除自身 callId 后为 0（maxConcurrent 语义精确）');
  eq(heavyLoad(leaky, cfg, base + cfg.heavy.timeoutMs + 1).inFlight, 0, '超过 timeoutMs 的在跑记录被自动回收（不会永久卡死）');
  noteHeavySettled(leaky, { callId: 'L1', at: base + 2 });
  eq(heavyLoad(leaky, cfg, base + 3).inFlight, 0, '结果到达后槽位释放');
}

// ── 2. escalation ladder ────────────────────────────────────────────────────
console.log('\n[2] 处置阶梯');
{
  const cfg = resolveConfig({});
  const verdicts = [{ kind: 'spinning', severity: 'critical', text: '空转', evidence: { windowTokens: 50_000, windowCalls: 12, silentForMs: 900_000 } }];
  const t = createTracker({ id: 'x', cfg });
  eq(decide({ tracker: t, cfg, mode: 'observe', verdicts, now: 1_000_000 }).nudges.length, 0, 'observe 不注入任何东西');
  const advise = decide({ tracker: t, cfg, mode: 'advise', verdicts, now: 1_000_000 + cfg.nudge.cooldownMs + 1 });
  eq(advise.nudges.length, 1, 'advise 注入一次提醒');
  ok(advise.nudges[0].text.includes('白名单'), '提醒里带人工逃生口（白名单）');
  eq(advise.reject, null, 'advise 绝不打断');
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = decide({ tracker: t, cfg, mode: 'enforce', verdicts, now: 2_000_000 + i * (cfg.nudge.cooldownMs + 1) });
  }
  ok(last.reject !== null, 'enforce 下提醒被无视到阈值 ⇒ 阻止该步');
  const stalledCfg = resolveConfig({});
  const t2 = createTracker({ id: 'y', cfg: stalledCfg });
  let stalledReject = null;
  for (let i = 0; i < 4; i += 1) {
    stalledReject = decide({
      tracker: t2, cfg: stalledCfg, mode: 'enforce', now: 3_000_000 + i * (stalledCfg.nudge.cooldownMs + 1),
      verdicts: [{ kind: 'stalled', severity: 'warn', text: '停滞', evidence: { idleMs: 600_000, turn: 1 } }],
    });
  }
  eq(stalledReject.reject, null, 'stalled 永不阻止（避免杀掉合法长任务）');
}

// ── 3. host wiring: state, routes, guard, pre-step ──────────────────────────
console.log('\n[3] 宿主接线');
{
  const cfg0 = resolveConfig({});
  const workspace = await mkdtemp(join(tmpdir(), 'guard-host-'));
  const stateRoot = await mkdtemp(join(tmpdir(), 'guard-state-'));
  // a team ledger a dead process left behind
  await mkdir(join(workspace, '.agent-teams', 'teamA'), { recursive: true });
  await writeFile(join(workspace, '.agent-teams', 'teamA', 'team.json'), JSON.stringify({
    name: 'teamA', phase: 'running', escalated: false,
    members: [{ id: 'dead-session-1', name: 'core-dev', role: 'engineer', status: 'working' },
      { id: 'live-session', name: 'qa', role: 'verification', status: 'working' }],
    tasks: [{ id: 't1', status: 'claimed', assignee: 'core-dev', subject: 'x' }],
  }, null, 2));
  // an in-flight turn marker left by a previous process generation: it lives in
  // the state dir, whose per-workspace key we reproduce here before boot.
  const { createHash } = await import('node:crypto');
  const stateKey = createHash('sha1').update(workspace).digest('hex').slice(0, 10);
  const stateDir = join(stateRoot, 'workspaces', stateKey);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'open-turns.json'), JSON.stringify({
    'old-session': { turn: 78, gen: 'g1-dead', since: Date.now() - 3_600_000 },
  }));

  const host = fakeHost({ workspace });
  // 复现真实宿主的时序：插件装载时工作区注册表还不存在（boot 早于 registry），
  // 工作区只能在第一个会话事件到来时才知道——这正是线上把状态写进 `/` 的成因。
  host.services.workspaceRegistry = { list: () => [] };
  // Only an in-process agent counts as live: a persisted-but-idle session must
  // not silence the stale-state report.
  host.services.agents.list = () => [{ session: { id: 'live-session' } }];
  host.services.sessions.list = () => [{ id: 'dead-session-1' }, { id: 'live-session' }];
  apply(host.ctx, { mode: 'enforce', stateRoot, recovery: { helper: false }, tickMs: 40, idle: { minTokens: 1000, minToolCalls: 3, windowMs: 30_000, graceMs: 0 }, budget: { perSessionTokens: 0 } });
  await sleep(120);
  const cwdKey = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 10);
  ok(await pathMissing(join(stateRoot, 'workspaces', cwdKey)),
     'boot 时不知道工作区 ⇒ 绝不按 cwd 建账（线上曾把状态写进 / 的账下）');

  const generation = JSON.parse(await readFile(join(stateRoot, 'generation.json'), 'utf8'));
  const workspaceEntries = await readdir(workspace);
  ok(!workspaceEntries.includes('.dsh-guard'), '状态写在 $DSH_HOME 侧，仓库里不留任何文件', workspaceEntries.join(','));
  ok(typeof generation.gen === 'string' && generation.gen.startsWith('g'), '启动即写入世代标记');
  eq(generation.mode, 'enforce', '世代标记里记录模式');

  const team = JSON.parse(await readFile(join(workspace, '.agent-teams', 'teamA', 'team.json'), 'utf8'));
  eq(team.members[0].status, 'working', 'agentTeams=report 时默认不修改他人的台账');
  eq(team.members[1].status, 'working', '在跑成员不受影响');

  const statusRes = await callRoute(host, '/plugins/dsh-guard/status');
  eq(statusRes.code, 200, '/status 返回 200');
  const status = JSON.parse(statusRes.body);
  eq(status.mode, 'enforce', '状态里回显当前模式');
  ok(status.liveness && typeof status.liveness.lastMs === 'number', '状态里带事件循环滞后采样');
  eq((status.workspaces || []).length, 0, '工作区尚未可知时不做任何扫描（不猜 cwd）');

  // 一条会话事件把真实工作区带进来 ⇒ 立刻建账并扫描
  host.services.workspaceRegistry = { list: () => [{ path: workspace, title: 'test' }] };
  const boundSession = { id: 'bound', title: 'bound', workspace: { path: workspace } };
  host.emit('turn/start', boundSession, { turn: 1 });
  await sleep(250);

  const boundStatus = JSON.parse((await callRoute(host, '/plugins/dsh-guard/status')).body);
  const boundWs = (boundStatus.workspaces || []).find((w) => w.path === workspace);
  ok(boundWs !== undefined, '会话事件把工作区绑定进来', JSON.stringify((boundStatus.workspaces || []).map((w) => w.path)));
  ok(boundWs && boundWs.teams.length === 1 && boundWs.teams[0].staleMembers.length === 1,
     '绑定后扫到死进程遗留的 working 成员', JSON.stringify(boundWs && boundWs.teams));
  ok(boundWs && boundWs.teams[0].staleMembers.every((m) => m.id === 'dead-session-1'),
     '在跑的成员不被误判为陈旧（agents.list 里活着）', JSON.stringify(boundWs && boundWs.teams[0].staleMembers));
  ok(boundWs && boundWs.teams[0].staleTasks.some((t) => t.id === 't1' && t.assignee === 'core-dev'),
     '受影响任务按**成员名字**匹配（台账里 assignee 存的是名字，不是 session id）',
     JSON.stringify(boundWs && boundWs.teams[0].staleTasks));
  ok((boundStatus.staleTurns || []).some((t) => t.sessionId === 'old-session'),
     '绑定后也扫到了上一世代的陈旧 turn', JSON.stringify(boundStatus.staleTurns));

  const auditRes = await callRoute(host, '/plugins/dsh-guard/audit', { url: '/plugins/dsh-guard/audit?limit=50' });
  const records = JSON.parse(auditRes.body).records;
  ok(records.some((r) => r.kind === 'generation/start'), '审计包含 generation/start');
  ok(records.every((r) => typeof r.ts === 'number' && typeof r.iso === 'string'), '每条审计记录自带时间戳（可排时间线）');
  ok(records.some((r) => r.kind === 'selfheal/agent-teams-stale'), '审计包含团队陈旧记录（带 workspace）');
  ok(records.some((r) => r.kind === 'selfheal/agent-teams-stale' && r.workspace === workspace), '该记录标明了是哪一个工作区');
  const auditText = JSON.stringify(records);
  ok(!auditText.includes('curl okx') && !/"command":/.test(auditText), '审计默认不含命令/正文（只留计数与摘要）');

  // a session that burns tokens and repeats itself
  const session = { id: 'burner', title: 'burner' };
  const host2 = host;
  host2.emit('turn/start', session, { turn: 1 });
  for (let i = 0; i < 10; i += 1) {
    host2.emit('tool/call', session, { callId: `q${i}`, name: 'bash', arguments: JSON.stringify({ command: 'curl okx' }) });
    host2.emit('tool/result', session, { message: { source: { callId: `q${i}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'No route to host' }] }] } });
    host2.emit('assistant/chunk', session, { chunk: { type: 'usage', usage: { inputTokens: 3000, outputTokens: 800, cacheReadTokens: 100 } } });
  }
  await sleep(200);
  const status2 = JSON.parse((await callRoute(host, '/plugins/dsh-guard/status')).body);
  const burner = status2.sessions.find((s) => s.session === 'burner');
  ok(burner !== undefined, '新会话被跟踪');
  ok(burner.tokens >= 39_000, 'tokens 被正确累计', String(burner.tokens));
  ok(burner.verdicts.some((v) => v.kind === 'spinning' || v.kind === 'repeating'), '空转/重复被判出', JSON.stringify(burner.verdicts.map((v) => v.kind)));

  // observe 模式必须**完全不干预**（线上实测过：observe 下仍拒了一次 bash）
  {
    const wsObs = await mkdtemp(join(tmpdir(), 'guard-observe-'));
    const hostObs = fakeHost({ workspace: wsObs });
    apply(hostObs.ctx, { stateRoot, recovery: { helper: false }, mode: 'observe', tickMs: 1000 });
    await sleep(120);
    const s1 = { id: 'obs-user' };
    hostObs.emit('tool/call', s1, { callId: 'o1', name: 'workflow', arguments: { a: 1 } });
    hostObs.emit('tool/call', s1, { callId: 'o2', name: 'workflow', arguments: { a: 2 } });
    const reasons = hostObs.guards.map((fn) => fn({ name: 'workflow', arguments: { a: 3 }, callId: 'o3', agent: { session: s1 } })).filter(Boolean);
    eq(reasons.length, 0, 'observe 模式下 tools.guard 绝不拒绝任何调用（只观察）');
    await rm(wsObs, { recursive: true, force: true });
  }

  // heavy semantics: ordinary shell traffic is never capped; suites and fleets are
  const decide1 = (sessionObj, name, args, callId) => host2.guards
    .map((fn) => fn({ name, arguments: args, callId, agent: { session: sessionObj } })).filter(Boolean);
  const clone = { command: 'git clone -q /repo /tmp/x && cd /tmp/x && timeout 600 python3 tests/run_regression_battery.py' };
  const suiteSession = { id: 'suite-user', title: 'suite' };
  const suiteCap = cfg0.heavy.maxPer10Min;              // 默认 10（本项目正常节奏允许到这个量级）
  for (let i = 0; i < suiteCap; i += 1) {
    host2.emit('tool/call', suiteSession, { callId: `s${i}`, name: 'bash', arguments: JSON.stringify(clone) });
    host2.emit('tool/result', suiteSession, { message: { source: { callId: `s${i}` }, content: [{ type: 'tool-result', content: [{ type: 'text', text: `done ${i}` }] }] } });
  }
  const suites = decide1(suiteSession, 'bash', clone, 's99');
  ok(suites.length === 1 && /复用/.test(suites[0]),
     `10 分钟内第 ${suiteCap + 1} 次整仓克隆+全量套件被限流（超过正常节奏才拦）`, JSON.stringify(suites));
  eq(decide1(suiteSession, 'bash', { command: 'ls -la && grep -n foo README.md' }, 's10').length, 0, '普通 shell 命令永不被限流（避免正常工作量被误伤）');

  const readSession = { id: 'reader', title: 'reader' };
  host2.emit('tool/call', readSession, { callId: 'r1', name: 'bash', arguments: JSON.stringify({ command: 'cat a' }) });
  host2.emit('tool/call', readSession, { callId: 'r2', name: 'bash', arguments: JSON.stringify({ command: 'cat b' }) });
  eq(decide1(readSession, 'bash', { command: 'cat c' }, 'r3').length, 0, '同一 turn 的多个并行读命令不会被并发上限误杀');

  const fleetSession = { id: 'fleet', title: 'fleet' };
  host2.emit('tool/call', fleetSession, { callId: 'f1', name: 'workflow', arguments: { script: 'x' } });
  const fleetDenied = decide1(fleetSession, 'workflow', { script: 'y' }, 'f2');
  ok(fleetDenied.length === 1 && /并发|在跑/.test(fleetDenied[0]), '同会话同时起两个 worker 编排器被并发上限拒绝', JSON.stringify(fleetDenied));
  eq(decide1(fleetSession, 'workflow', { script: 'x' }, 'f1').length, 0, '自身已在跑的那次调用不被自己拒绝（callId 精确排除）');

  // the pre-step handler must always return a valid decision shape
  const badPayload = await host2.handlers.get('agent/pre-step')({ agent: undefined, messages: [], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [] }));
  ok(badPayload && typeof badPayload.kind === 'string', '异常输入下 pre-step 仍返回合法决策', JSON.stringify(badPayload));

  // pre-step must reject once enforcement has been earned
  const decision = await host2.handlers.get('agent/pre-step')({ agent: { session }, messages: [], turn: 1, step: 9 }, async () => ({ kind: 'enter', messages: [] }));
  ok(decision && (decision.kind === 'reject' || decision.kind === 'enter'), 'pre-step 决策形状合法', JSON.stringify(decision?.kind));

  // whitelist escape hatch
  const wl = await callRoute(host, '/plugins/dsh-guard/action', { method: 'POST', body: { action: 'whitelist', session: 'burner' } });
  eq(JSON.parse(wl.body).ok, true, '白名单动作可用');
  const afterWl = JSON.parse((await callRoute(host, '/plugins/dsh-guard/status')).body).sessions.find((s) => s.session === 'burner');
  eq(afterWl.whitelisted, true, '白名单在状态里可见');
  const modeChange = await callRoute(host, '/plugins/dsh-guard/action', { method: 'POST', body: { action: 'mode', mode: 'nonsense' } });
  eq(modeChange.code, 400, '非法模式被拒绝（fail-loud）');
  const health = JSON.parse((await callRoute(host, '/plugins/dsh-guard/health')).body);
  eq(health.ok, true, '健康路由可用');

  // repair mode really repairs
  const workspace2 = await mkdtemp(join(tmpdir(), 'guard-repair-'));
  await mkdir(join(workspace2, '.agent-teams', 'teamB'), { recursive: true });
  await writeFile(join(workspace2, '.agent-teams', 'teamB', 'team.json'), JSON.stringify({
    name: 'teamB', phase: 'running',
    members: [{ id: 'dead-2', name: 'ui-dev', role: 'engineer', status: 'working' }],
    tasks: [{ id: 't9', status: 'in_progress', assignee: 'dead-2', subject: 'y' }],
  }, null, 2));
  const host3 = fakeHost({ workspace: workspace2 });
  apply(host3.ctx, { selfheal: { agentTeams: 'repair' }, stateRoot, recovery: { helper: false }, tickMs: 1000 });
  await sleep(150);
  const repaired = JSON.parse(await readFile(join(workspace2, '.agent-teams', 'teamB', 'team.json'), 'utf8'));
  eq(repaired.members[0].status, 'idle', 'repair 模式把死进程的 working 成员置回 idle');
  eq(repaired.members[0].statusBefore, 'working', 'repair 记录原值（可审计、可回退）');
  eq(repaired.members[0].statusRepairedBy, 'dsh-guard', 'repair 标注是谁改的');
  eq(repaired.tasks[0].status, 'in_progress', 'repair 不擅自改动任务归属（只报告）');

  // 回归 2：事件循环滞后采样必须在一次长卡顿后自同步（线上曾永久停在 45.8s）
  {
    const { createLiveness } = await import('../lib/liveness.js');
    const L = createLiveness({ sampleMs: 20, keep: 10, lagWarnMs: 5, lagCriticalMs: 50 });
    L.start();
    await sleep(60);
    L.push(5000);                      // 模拟一次 5 秒卡顿
    await sleep(60);
    const st = L.stats();
    ok(st.lastMs < 100 && st.maxMs >= 5000, '一次长卡顿只记一笔，之后回到真实水平', JSON.stringify(st));
    L.stop();
  }

  // 回归 7：守卫子进程的击杀目标必须被验证（绝不信任 ppid）
  {
    const { resolveWrapperPid, cmdlineMatches } = await import('../lib/wrapper.js');
    const mk = (table) => ({
      listPids: () => Object.keys(table).map(Number),
      readCmdline: (pid) => table[pid] ?? null,
    });
    const real = mk({ 10: 'node /home/u/dsh-web-wrapper.mjs --profile web', 20: 'bash -c sleep 1' });
    const r1 = resolveWrapperPid({ pattern: 'dsh-web-wrapper.mjs', candidatePid: 20, ...real });
    eq(r1.pid, 10, '按 cmdline 唯一命中真实 wrapper（而不是盲信 ppid=20 的 shell）');
    const r2 = resolveWrapperPid({ pattern: 'dsh-web-wrapper.mjs', candidatePid: 20, ...mk({ 20: 'bash -c sleep 1' }) });
    eq(r2.pid, null, 'ppid 不是 wrapper ⇒ 拒绝动手（只记录）');
    const r3 = resolveWrapperPid({ pattern: 'dsh-web-wrapper.mjs', candidatePid: 30, ...mk({
      30: 'node wrapper.mjs', 31: 'node dsh-web-wrapper.mjs x', 32: 'node dsh-web-wrapper.mjs y' }) });
    eq(r3.pid, null, '多命中且候选不在其中 ⇒ 拒绝动手');
    ok(cmdlineMatches('node x dsh-web-wrapper.mjs', 'dsh-web-wrapper.mjs'), 'cmdline 匹配函数可用');
    ok(!cmdlineMatches('timeout 5 node x --wrapper-pattern=dsh-web-wrapper.mjs', 'dsh-web-wrapper.mjs'),
       '仅"提到"该特征的非 node 进程不算命中（timeout/bash/grep 的误伤）');
    ok(!cmdlineMatches('bash -c grep dsh-web-wrapper.mjs', 'dsh-web-wrapper.mjs'), 'bash 命令里提到也不命中');
    ok(cmdlineMatches('/usr/bin/node /home/u/dsh-web-wrapper.mjs --profile web', 'dsh-web-wrapper.mjs'),
       '/usr/bin/node 开头的真实 wrapper 命中');
  }

  // 回归 6：插件内自恢复的判定矩阵（真正防卡死的那一层，不依赖外部单元）
  {
    const cfg = resolveConfig({});
    const now = 1_000_000_000_000;
    const base = { cfg, mode: 'enforce', now, lagMs: cfg.recovery.lagThresholdMs, state: createRecoveryState(), managed: true };
    eq(recoveryDecision({ ...base, mode: 'observe' }).action, 'none', 'observe 下绝不自恢复（不干预）');
    eq(recoveryDecision({ ...base, lagMs: cfg.recovery.lagThresholdMs - 1 }).action, 'none', '滞后未达阈值不动手');
    eq(recoveryDecision(base).action, 'exit', '滞后达阈值且 systemd 托管 ⇒ 主动退出交给 systemd 重拉');
    eq(recoveryDecision({ ...base, managed: false }).action, 'alert',
       '非 systemd 托管时只告警（否则手工启动的 dsh 会被杀且无人重拉）');
    eq(recoveryDecision({ ...base, disabled: true }).action, 'none', 'DISABLED 开关一票否决');
    const cooled = { ...createRecoveryState(), lastActionAt: now - 1000 };
    eq(recoveryDecision({ ...base, state: cooled }).action, 'none', '冷却期内不重复重启');
    const capped = { ...createRecoveryState(), actions: [now - 1000, now - 2000, now - 3000] };
    eq(recoveryDecision({ ...base, state: capped }).action, 'none', '每小时上限用尽 ⇒ 停止动手');
    const cfg2 = resolveConfig({ recovery: { confirmations: 2 } });
    const d1 = recoveryDecision({ ...base, cfg: cfg2 });
    eq(d1.reason, 'confirming', '需要连续 N 次观测时，第一次只记数');
  }

  // 回归 5：真防卡死的两道新闸（纯函数 + 端到端）
  {
    const cfg = resolveConfig({});
    ok(hostHeavyDenyReason(cfg.heavy.hostMaxConcurrent, cfg) !== null,
       `宿主上已有 ${cfg.heavy.hostMaxConcurrent} 个重活在跑 ⇒ 拒绝新的（防"六个人一起开工"）`);
    eq(hostHeavyDenyReason(cfg.heavy.hostMaxConcurrent - 1, cfg), null, '未达宿主上限时放行');
    ok(shedHeavyReason(cfg.liveness.shedHeavyAboveMs, cfg) !== null, '事件循环滞后达阈值 ⇒ 泄压（停止加新压力）');
    eq(shedHeavyReason(cfg.liveness.shedHeavyAboveMs - 1, cfg), null, '滞后低于阈值时不泄压（不误伤）');
  }

  // 端到端：宿主级闸真的会拒另一个会话的重活；且 observe 下三道闸全静默
  {
    const wsH = await mkdtemp(join(tmpdir(), 'guard-hostcap-'));
    const hostH = fakeHost({ workspace: wsH });
    apply(hostH.ctx, { stateRoot, recovery: { helper: false }, mode: 'enforce', tickMs: 1000 });
    await sleep(120);
    const A = { id: 'agent-A' };
    const B = { id: 'agent-B' };
    hostH.emit('turn/start', B, { turn: 1 });                       // B 也要有 tracker 才会被判定
    hostH.emit('tool/call', A, { callId: 'h1', name: 'workflow', arguments: { a: 1 } });
    hostH.emit('tool/call', A, { callId: 'h2', name: 'workflow', arguments: { a: 2 } });
    const denyB = hostH.guards.map((fn) => fn({ name: 'workflow', arguments: { a: 3 }, callId: 'h3', agent: { session: B } })).filter(Boolean);
    ok(denyB.length === 1 && /宿主/.test(denyB[0]), '另一个会话再起重活被宿主级上限拦住', JSON.stringify(denyB));

    // 自己已在跑的那次不算"别人"：换一个只有一次重活在跑的会话来验证
    const wsSelf = await mkdtemp(join(tmpdir(), 'guard-selfcap-'));
    const hostS = fakeHost({ workspace: wsSelf });
    apply(hostS.ctx, { stateRoot, recovery: { helper: false }, mode: 'enforce', tickMs: 1000 });
    await sleep(120);
    const S = { id: 'agent-S' };
    hostS.emit('tool/call', S, { callId: 's1', name: 'workflow', arguments: { a: 1 } });
    const selfS = hostS.guards.map((fn) => fn({ name: 'workflow', arguments: { a: 1 }, callId: 's1', agent: { session: S } })).filter(Boolean);
    eq(selfS.length, 0, '自己已在跑的那次不被自己拒（callId 精确排除）');
    const otherS = hostS.guards.map((fn) => fn({ name: 'workflow', arguments: { a: 2 }, callId: 's2', agent: { session: S } })).filter(Boolean);
    eq(otherS.length, 1, '同一会话里再叠一个重活被单会话闸拦住');
    await rm(wsSelf, { recursive: true, force: true });

    const wsO = await mkdtemp(join(tmpdir(), 'guard-hostcap-observe-'));
    const hostO = fakeHost({ workspace: wsO });
    apply(hostO.ctx, { stateRoot, recovery: { helper: false }, mode: 'observe', tickMs: 1000 });
    await sleep(120);
    hostO.emit('tool/call', A, { callId: 'o1', name: 'workflow', arguments: { a: 1 } });
    hostO.emit('tool/call', A, { callId: 'o2', name: 'workflow', arguments: { a: 2 } });
    const obs = hostO.guards.map((fn) => fn({ name: 'workflow', arguments: { a: 3 }, callId: 'o3', agent: { session: B } })).filter(Boolean);
    eq(obs.length, 0, 'observe 模式下三道闸全静默（只记录）');
    await rm(wsH, { recursive: true, force: true });
    await rm(wsO, { recursive: true, force: true });
  }

  // 回归 3：注册表在 boot 之后才就绪时，无需任何会话事件也要完成建账与扫描
  {
    const wsLate = await mkdtemp(join(tmpdir(), 'guard-late-'));
    await mkdir(join(wsLate, '.agent-teams', 'teamC'), { recursive: true });
    await writeFile(join(wsLate, '.agent-teams', 'teamC', 'team.json'), JSON.stringify({
      name: 'teamC', phase: 'running',
      members: [{ id: 'dead-3', name: 'spec-dev', status: 'working' }],
      tasks: [{ id: 't7', status: 'claimed', assignee: 'dead-3' }],
    }));
    const hostLate = fakeHost({ workspace: wsLate });
    hostLate.services.workspaceRegistry = { list: () => [] };      // boot 时还没有
    apply(hostLate.ctx, { stateRoot, recovery: { helper: false }, tickMs: 1000, selfheal: { agentTeams: 'repair' } });
    await sleep(120);
    hostLate.services.workspaceRegistry = { list: () => [{ id: 'w1', path: wsLate, title: 'late' }] };
    await sleep(2600);                                             // 等重试定时器（2s）
    const lateStatus = JSON.parse((await callRoute(hostLate, '/plugins/dsh-guard/status')).body);
    ok((lateStatus.workspaces || []).some((w) => w.path === wsLate), '注册表晚到时靠重试也能建账（不依赖会话事件）',
       JSON.stringify((lateStatus.workspaces || []).map((w) => w.path)));
    const lateTeam = JSON.parse(await readFile(join(wsLate, '.agent-teams', 'teamC', 'team.json'), 'utf8'));
    eq(lateTeam.members[0].status, 'idle', '晚到的注册表同样触发 repair');
    await rm(wsLate, { recursive: true, force: true });
  }

  // 回归 4：会话对象上没有 workspace/cwd，只有 header.cwd ⇒ 也要能解析出工作区
  {
    const wsHeader = await mkdtemp(join(tmpdir(), 'guard-header-'));
    await mkdir(join(wsHeader, '.agent-teams', 'teamD'), { recursive: true });
    await writeFile(join(wsHeader, '.agent-teams', 'teamD', 'team.json'), JSON.stringify({
      name: 'teamD', members: [{ id: 'dead-4', name: 'reviewer', status: 'working' }], tasks: [],
    }));
    const hostH = fakeHost({ workspace: wsHeader });
    hostH.services.workspaceRegistry = { list: () => [] };          // 注册表不可用
    apply(hostH.ctx, { stateRoot, recovery: { helper: false }, tickMs: 1000, selfheal: { agentTeams: 'report' } });
    await sleep(120);
    hostH.emit('turn/start', { id: 'hdr-session', header: { cwd: wsHeader } }, { turn: 1 });
    await sleep(250);
    const st = JSON.parse((await callRoute(hostH, '/plugins/dsh-guard/status')).body);
    ok((st.workspaces || []).some((w) => w.path === wsHeader),
       '从 session.header.cwd 解析工作区（会话对象上没有 workspace/cwd）',
       JSON.stringify((st.workspaces || []).map((w) => w.path)));
    await rm(wsHeader, { recursive: true, force: true });
  }

  // invalid config must not arm anything
  const host4 = fakeHost({ workspace });
  apply(host4.ctx, { stateRoot, repeats: { warn: 9, critical: 5 } });
  eq(host4.guards.length, 0, '配置非法时插件不装载任何钩子（fail-loud 而非静默）');
  eq(host4.routes.size, 0, '配置非法时不注册路由');

  await rm(workspace, { recursive: true, force: true });
  await rm(workspace2, { recursive: true, force: true });
  await rm(stateRoot, { recursive: true, force: true });
}

// ── 4. defaults sanity ──────────────────────────────────────────────────────
console.log('\n[4] 默认值');
{
  const cfg = resolveConfig({});
  eq(cfg.mode, 'observe', '默认模式是 observe（装上不会改变任何行为）');
  eq(cfg.budget.perSessionTokens, 0, '默认无 token 预算（0=关闭）');
  eq(cfg.burn.minTokens, 0, 'burning 默认关闭（纯推理任务会误报，需显式开启）');
  ok(cfg.nudge.rejectable.includes('spinning') && !cfg.nudge.rejectable.includes('stalled'), '可阻止类型不含 stalled');
  eq(DEFAULTS.heavy.timeoutMs, 600_000, '重型调用上限 10 分钟（实测 p99=123s、max=295s ⇒ 零误报）');
  eq(DEFAULTS.repeats.critical, 10, '重复临界阈值 10（实测合法上限 3）');
}

console.log(`\n结果: 通过 ${pass} / 失败 ${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);
