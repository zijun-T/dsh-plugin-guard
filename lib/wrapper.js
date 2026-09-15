/**
 * 找到并**验证** DSH 的 wrapper 进程 —— 守卫子进程唯一允许动手的目标。
 *
 * 为什么必须验证：子进程若直接信任 `process.ppid`，那么当宿主不是由 wrapper 拉起时
 * （手工启动、测试里跑、或被别的进程 spawn），ppid 完全可能是**无关进程**，一次误判
 * 就会 SIGKILL 掉一个无辜的 shell。所以这里同时做两件事：
 *   1. 扫描 /proc 找出 cmdline 命中 wrapper 特征的进程（权威来源）；
 *   2. 只有在它唯一、且候选 ppid 的 cmdline 也命中时，才允许作为击杀目标。
 * 任何不确定 ⇒ 返回 null（只记录不动手）。
 */

/**
 * 严格判定：既要命中特征，**又要是 node 进程**。
 *
 * 只匹配特征会误伤"仅仅提到这个名字"的进程 —— 实测里 bash 的 `timeout ... --wrapper-pattern=…`
 * 命令、`grep dsh-web-wrapper.mjs` 都会命中。加上"首个参数是 node 可执行文件"这一条，
 * 才能保证候选真的是 wrapper 本体。
 */
export function cmdlineMatches(cmdline, pattern) {
  if (typeof cmdline !== 'string' || cmdline.length === 0) return false;
  if (!cmdline.includes(pattern)) return false;
  const argv0 = cmdline.trim().split(/\s+/)[0] ?? '';
  return /(^|\/)node(\.exe)?$/.test(argv0);
}

/**
 * @param pattern  wrapper 命令行特征（默认 'dsh-web-wrapper.mjs'）
 * @param candidatePid 插件传下来的 ppid（可空）
 * @param listPids  返回所有 pid 的函数
 * @param readCmdline pid => cmdline 字符串（失败返回 null）
 * @returns {{ pid: number|null, source: 'scan'|'candidate'|null, reason: string }}
 */
export function resolveWrapperPid({ pattern, candidatePid = null, listPids, readCmdline }) {
  const matches = [];
  for (const pid of listPids()) {
    if (pid === process.pid) continue;
    const cmdline = readCmdline(pid);
    if (cmdlineMatches(cmdline, pattern)) matches.push(pid);
  }
  if (matches.length === 1) return { pid: matches[0], source: 'scan', reason: 'unique-match' };
  if (matches.length > 1) {
    // 多命中：只有候选也命中时才敢用，否则拒绝
    if (candidatePid !== null && matches.includes(candidatePid)) {
      return { pid: candidatePid, source: 'candidate', reason: 'multiple-matches-candidate-ok' };
    }
    return { pid: null, source: null, reason: `multiple-matches(${matches.length})` };
  }
  if (candidatePid !== null && cmdlineMatches(readCmdline(candidatePid), pattern)) {
    return { pid: candidatePid, source: 'candidate', reason: 'scan-empty-candidate-ok' };
  }
  return { pid: null, source: null, reason: 'no-wrapper-found' };
}
