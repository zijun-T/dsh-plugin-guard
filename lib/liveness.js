/**
 * Responsiveness sampling — the exact signal that was missing when the Web UI
 * went blank: the agent runtime and the web server share one event loop, so a
 * blocked loop IS the outage. Drift of a 1s interval is the cheapest direct
 * measurement of that, and it needs no HTTP request of its own.
 */
export function createLiveness({ sampleMs, keep, lagWarnMs, lagCriticalMs }) {
  const samples = [];
  let lastSample = null;
  let peak = 0;
  let timer = null;
  let wall = 0;
  let lastFired = 0;

  function push(lag) {
    lastSample = lag;
    if (lag > peak) peak = lag;
    samples.push(lag);
    while (samples.length > keep) samples.shift();
  }

  function start() {
    if (timer) return;
    lastFired = Date.now();
    timer = setInterval(() => {
      // 相对**上一次实际触发**测量：一次长卡顿只记一笔，之后立刻回到真实水平。
      // （用绝对时间表测量会永久留下固定偏差——本机实测过一次 45.8s 卡死后，
      //   指标就再也回不来了，这正是"看起来一直在卡"的假象。）
      const now = Date.now();
      push(Math.max(0, now - lastFired - sampleMs));
      wall += now - lastFired;
      lastFired = now;
    }, sampleMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stats() {
    if (samples.length === 0) {
      return { samples: 0, lastMs: 0, avgMs: 0, p95Ms: 0, maxMs: 0, level: 'unknown', wallMs: wall };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const last = lastSample ?? 0;
    const level = last >= lagCriticalMs ? 'critical' : (last >= lagWarnMs || p95 >= lagWarnMs ? 'warn' : 'ok');
    return { samples: samples.length, lastMs: last, avgMs: Math.round(avg), p95Ms: p95, maxMs: peak, level, wallMs: wall };
  }

  return { start, stop, stats, sample: () => lastSample, push };
}
