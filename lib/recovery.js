/**
 * 自恢复：把"看门狗"做成插件自己的一部分，而不是一个外挂的 systemd 单元。
 *
 * 两种机制，各自负责不同的卡死形态：
 *
 * 1. **插件内自杀式重启**（`selfExit`）
 *    事件循环被卡住时，插件自己的定时器**不会准时触发**——但它会在循环每次被释放
 *    的瞬间"迟到地"触发。所以只要循环还会恢复（本机实测的形态：5.9s / 45s 的滞后，
 *    之后都会恢复），插件就能在恢复的那一刻发现"我迟到了 N 秒"，并主动退出：
 *    `process.exit(1)` → systemd（Restart=on-failure, RestartSec=3）3 秒内把宿主重拉。
 *    不需要 root、不需要额外单元。
 *
 * 2. **插件自己拉起的守卫子进程**（`helper`）
 *    如果循环**再也不回来**（真死循环），进程内任何代码都跑不了——这时唯一能救的是
 *    一个独立进程。它由插件在装载时 spawn（detached + unref，随插件生命周期而生），
 *    因此仍然是"插件的一部分"，不需要 sudo、不需要 systemd 单元：
 *    它探 `/plugins/dsh-guard/health`，连续失败就 SIGKILL 掉 wrapper
 *    （wrapper 属当前用户，无需提权）→ systemd 判定失败并重拉宿主。
 *
 * 安全闸（两者共用）：默认只在 `enforce` 下生效；冷却 + 每小时上限；`DISABLED`
 * 文件；以及"必须确属 systemd 托管"（存在 INVOCATION_ID）才允许 exit —— 否则一个
 * 手工启动的 dsh 会被直接杀掉且无人重拉。
 */

/** 判定：现在该不该自恢复？（纯函数，便于测试） */
export function recoveryDecision({
  cfg, mode, now, lagMs, state, managed, disabled = false,
}) {
  const rc = cfg.recovery;
  if (!rc.enabled || disabled) return { action: 'none', reason: 'disabled' };
  if (mode !== 'enforce') return { action: 'none', reason: 'mode' };
  if (!(lagMs >= rc.lagThresholdMs)) return { action: 'none', reason: 'below-threshold' };

  // 同一次卡死只处置一次
  if (state.lastActionAt !== 0 && now - state.lastActionAt < rc.cooldownMs) {
    return { action: 'none', reason: 'cooldown' };
  }
  const recent = state.actions.filter((ts) => now - ts <= 3_600_000);
  if (recent.length >= rc.maxPerHour) return { action: 'none', reason: 'rate-cap' };

  // 需要连续 N 次超阈值的观测（默认 2）：避免单次抖动就重启
  const streak = (state.streak ?? 0) + 1;
  if (streak < rc.confirmations) return { action: 'none', reason: 'confirming', streak };

  if (!managed) return { action: 'alert', reason: 'not-systemd-managed' };
  return rc.selfExit ? { action: 'exit', reason: 'lag', streak } : { action: 'alert', reason: 'selfExit-off', streak };
}

/** 记录一次处置（纯函数返回新状态）。 */
export function recordAction(state, now) {
  return {
    ...state,
    lastActionAt: now,
    actions: [...(state.actions ?? []), now].slice(-64),
    streak: 0,
  };
}

export function createRecoveryState() {
  return { lastActionAt: 0, actions: [], streak: 0 };
}
