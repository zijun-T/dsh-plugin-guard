#!/usr/bin/env node
/**
 * dsh-guard 守卫子进程 —— 由插件 spawn（detached + unref），负责"循环再也不回来"这种
 * 唯一进程内无解的形态。
 *
 * 它只做一件事：探宿主的健康路由；连续 N 次失败 ⇒ SIGKILL 掉 wrapper
 * （wrapper 属当前用户，不需要 root；systemd 的 Restart=on-failure 会把宿主重拉，
 *   随后世代闸自动收拾僵尸状态）。
 *
 * 用法（由插件传入）：
 *   node helper.mjs --url=<health-url> --wrapper-pid=<pid> [--interval=5] [--timeout=3]
 *                   [--fails=3] [--cooldown=600] [--max-per-hour=3] [--state-dir=...] [--dry-run]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWrapperPid } from './wrapper.js';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (m) args.set(m[1], m[2] ?? 'true');
}
const url = args.get('url') ?? 'http://127.0.0.1:3080/plugins/dsh-guard/health';
const candidatePid = Number(args.get('wrapper-pid') ?? 0) || null;
const wrapperPattern = args.get('wrapper-pattern') ?? 'dsh-web-wrapper.mjs';
const intervalMs = Number(args.get('interval') ?? 5) * 1000;
const timeoutMs = Number(args.get('timeout') ?? 3) * 1000;
const failsToAct = Number(args.get('fails') ?? 3);
const cooldownMs = Number(args.get('cooldown') ?? 600) * 1000;
const maxPerHour = Number(args.get('max-per-hour') ?? 3);
const dryRun = args.get('dry-run') === 'true';
const stateDir = args.get('state-dir') ?? join(process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh'), 'guard', 'helper');
mkdirSync(stateDir, { recursive: true });
const logFile = join(stateDir, 'helper.log');

const readCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
  } catch {
    return null;
  }
};
const listPids = () => {
  try {
    return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number);
  } catch {
    return [];
  }
};

const log = (message) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch { /* 日志失败绝不能影响恢复动作 */ }
};

let fails = 0;
let seenHealthy = false;
let lastActionAt = 0;
const actions = [];

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 目标解析 + 校验：不确定就只记录，绝不动手
const resolved = resolveWrapperPid({ pattern: wrapperPattern, candidatePid, listPids, readCmdline });
const wrapperPid = resolved.pid;
log(`helper start url=${url} candidate-ppid=${candidatePid} wrapper=${wrapperPid ?? 'none'} source=${resolved.source ?? '-'} reason=${resolved.reason} interval=${intervalMs}ms fails=${failsToAct} dryRun=${dryRun}`);
if (wrapperPid === null) log(`⚠ 无法确认 wrapper 进程（${resolved.reason}）⇒ 本进程只记录、不会击杀任何进程`);

async function tick() {
  const { ok, ms } = await probe();
  if (ok && ms < timeoutMs) {
    if (!seenHealthy) { seenHealthy = true; log(`first healthy ${ms}ms`); }
    fails = 0;
    return;
  }
  fails += 1;
  log(`probe failed ${fails}/${failsToAct} (${ms}ms)`);
  if (fails < failsToAct) return;
  fails = 0;

  if (!seenHealthy) { log('never healthy ⇒ 只记录（服务可能本来就没起）'); return; }
  if (existsSync(join(stateDir, 'DISABLED'))) { log('DISABLED ⇒ 只记录'); return; }
  const now = Date.now();
  if (now - lastActionAt < cooldownMs) { log('cooldown ⇒ 跳过'); return; }
  if (actions.filter((ts) => now - ts <= 3_600_000).length >= maxPerHour) { log('rate-cap ⇒ 停止动手，请人工介入'); return; }

  if (!wrapperPid) { log('未确认 wrapper ⇒ 只记录（安全闸）'); return; }
  // 每轮重新校验：wrapper 可能已经被别人重启替换成另一个 pid
  const fresh = resolveWrapperPid({ pattern: wrapperPattern, candidatePid: wrapperPid, listPids, readCmdline });
  if (fresh.pid === null) { log(`wrapper 校验失败（${fresh.reason}）⇒ 放弃动手`); return; }
  if (dryRun) { log(`dry-run → 本该 SIGKILL wrapper ${fresh.pid}`); return; }
  try {
    process.kill(fresh.pid, 'SIGKILL');
    lastActionAt = now;
    actions.push(now);
    log(`SIGKILL wrapper ${fresh.pid} ⇒ systemd 应重拉宿主（action=restart epoch=${Math.floor(now / 1000)}）`);
    writeFileSync(join(stateDir, 'last-restart'), `${new Date().toISOString()}\n`);
  } catch (error) {
    log(`kill 失败：${error?.message ?? error}`);
  }
}

void tick();
setInterval(() => { void tick(); }, intervalMs);
