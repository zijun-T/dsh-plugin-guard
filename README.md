# dsh-guard

DSH 运行时守卫。它回答宿主自己不会回答的三个问题：

1. **这个会话是不是卡住了？**（会话停滞、事件循环被占死 ⇒ 网页能开、历史拉不出来）
2. **它是不是在疯狂烧 token 却没产出？**（空转比：花了多少 tokens / 有没有真的推进）
3. **上一个进程死掉后留下了什么？**（成员永远 `working`、claim 永远占住、任务没人领）

它**不懂任何业务**：不看你的项目、不读你的代码、不调模型。它只看三样宿主内部就能看到的东西——**花费**（tokens）、**活动**（工具调用）、**进展**（该会话里从未出现过的新结果）。

---

## 为什么阈值长这样（全部来自本机实测，不是拍脑袋）

| 阈值 | 默认值 | 依据（本机 4675 次工具调用 / 7 个会话 / 15 小时） |
|---|---|---|
| 重型调用上限 `heavy.timeoutMs` | 600 000 ms | 工具调用 p50 4.9s、p90 36.7s、p99 123s、**max 295s** ⇒ 10 分钟硬上限**零误报** |
| 连续重复 `repeats.warn/critical` | 5 / 10 | 连续相同调用的**合法上限实测为 3** |
| 被拒重试 `refusals.limit` | 3 | 实测同一任务 claim 被拒最多 **6 次**（t2），3 次已经异常 |
| 空转窗口 `idle.windowMs` | 10 分钟 | 同窗口内 `minTokens` 20k + `minToolCalls` 8 才算"在忙却没产出" |
| 停滞 `heartbeat.suspectMs` | 10 分钟 | 实测有 **7 个会话同时卡 ~900 秒**，全部是 provider 传输重试 |
| 并发/限流 `heavy.maxConcurrent/maxPer10Min` | 1 / **10** | 实测 36 分钟内 5 次全量电池 + 12 次整仓克隆属**正常节奏** ⇒ 上限设在明显失控之上（初版 3 太紧，已放宽） |
| 预算 `budget.*` | 全 0（关闭） | 没有你的定价表就只报 tokens，不猜钱 |

**最重要的一条设计结论**：**墙钟时间永远不能单独作为"死循环"的判据**。上面那 7 个会话同时卡 900 秒，如果用"5 分钟没动静就判死循环并杀"，一刀会把整个团队团灭。所以除 `stalled`（永不拒绝）外，每个判定都建立在**离散计数**上。

---

## 安装 / 卸载 / 回滚

```bash
# 安装（把本包目录或 tgz 装进指定 profile）
dsh plugin --profile web add /path/to/dsh-guard

# 回滚（三级，任选）
#   1) 最轻：把配置改成 mode: observe —— 只记录不干预
#   2) 停用：dsh plugin --profile web remove dsh-guard
#   3) 完全不留痕：删除 $DSH_HOME/guard/<workspace-key>/（世代/审计文件）
```

默认 `mode: observe`：**装上不会改变任何行为**，只会写审计与 `/status`。

---

## 三种模式与处置阶梯

| 模式 | 记录/审计 | `/status` | 注入提醒 | 拒绝该步 / 拒绝工具 |
|---|---|---|---|---|
| `observe`（默认） | ✅ | ✅ | ✗ | ✗ —— **绝不拒绝任何调用**（`tools.guard` 只在 `enforce` 下生效） |
| `advise` | ✅ | ✅ | ✅ | ✗ |
| `enforce` | ✅ | ✅ | ✅ | ✅（且只在提醒被无视 `nudge.rejectAfterNudges` 次之后） |

`enforce` 的两把硬闸：

* `tools.guard`（**同步**、执行前）：并发/限流的重量级调用直接拒绝，并给出可读理由；
* `agent/pre-step` 返回 `{kind:'reject'}`：该 turn 以 **`blocked`** 结束——这是宿主的**一等终态**，不是挂起（不会又留一个 `working` 僵尸）。

人工逃生口：`POST /plugins/dsh-guard/action {action:'whitelist', session}`，白名单会话不再被判/被拦（状态里可见）。

---

## 判定规则（5 种，全部可解释）

| 判定 | 触发条件（离散） | 严重度 | 会不会拒绝 |
|---|---|---|---|
| `spinning` | 窗口内 tokens ≥ 20k 且工具调用 ≥ 8，但**已有 10 分钟没有任何新颖产物/台账推进**，且会话仍在活动 | critical | enforce 下会 |
| `repeating` | 连续相同参数**且结果相同**的调用 ≥ 5（警告）/ ≥ 10（临界） | warn/critical | enforce 下会 |
| `polling` | 相同参数但**结果在变**（像轮询，合法） | info | **永不**（只为可见性） |
| `refusing` | 同一工具在窗口内被拒 ≥ 3 次 | warn | 不拒绝（改为要求上报） |
| `burning`（可选，默认关） | 窗口内 tokens ≥ 阈值但工具活动 ≤ 2 | warn | 永不 |
| `stalled` | turn 仍开启但 10/30 分钟无事件 | warn/critical | **永不**（长命令/网络重试不算错） |
| `over-budget` | 超过会话 token/金额/turn 时长预算 | warn/critical | 按 `budget.onExceed` |

`spinning` 的核心是"**没有新颖结果**"：同一个调用、同一个答案重复 N 次不算进展，无论它多贵；而换一个参数拿到新信息就算进展。

---

## 防卡死：三道进程内闸 + 一道进程外看门狗

**卡死的本质**：DSH 把 Web UI 与 agent 运行时放在**同一个 node 进程、同一条事件循环**上。
循环被占住（大量会话重放、多个成员同时干重活、压缩）⇒ 页面直接死。实测过一次恢复里
6 个成员被同时唤醒、宿主进程 59 秒烧满一个核、事件循环滞后 p95 达 5.9 秒。

### 进程内三道闸（仅 `enforce` 生效，`observe` 绝不干预）

| 闸 | 默认 | 拦什么 |
|---|---|---|
| 单会话并发 `heavy.maxConcurrent` | 1 | 同一个 agent 把重活叠起来 |
| **宿主级并发 `heavy.hostMaxConcurrent`** | 2 | **多个成员同时开工**（卡死的直接成因） |
| **滞后泄压 `liveness.shedHeavyAboveMs`** | 2000ms | 事件循环已经在滞后时，**先停止加新压力**，回落再放行 |

「重型」的定义是精确的：orchestrator 工具（`workflow`/`subagent`/`ralph`…）或命中套件正则的 shell
（`git clone` / `run_all_tests` / `--allow-panel` / `pytest`…）。普通 `ls`/`grep`/`cat` 永不被限。

每次拦截都写审计（`action/denied-heavy` / `action/denied-heavy-host` / `action/shed-heavy`），
所以"为什么这次没跑起来"永远有据可查。

### 进程外看门狗（唯一能救回"已经卡死"的那一层）

进程内守卫在循环被占死时**自己也跑不动**，所以恢复必须由独立进程完成：

```
dsh-guard-watchdog.sh   探 /plugins/dsh-guard/health（每 5s，超时 3s）
  连续 3 次超时/非 200 ⇒ 抓证据快照（/status、审计尾部、ps top、journal 尾部）
                     ⇒ systemctl restart dsh-web.service ⇒ 等恢复并记录耗时
安全：必须曾经健康过一次才重启（不会把你故意停掉的服务拉起来）；
     冷却 600s、每小时上限 3 次（不会重启风暴）；DISABLED 文件可一键只记录。
```

看门狗重启宿主后，**世代闸会自动把僵尸状态归位**（就是前面 `selfheal/agent-teams-repaired` 那套）。

## 明确**不做**的事

* 不调用任何模型（守卫自己不能成为新的扣费源）；
* 不写入你的仓库（状态写 `$DSH_HOME/guard/<workspace-key>/`）；
* 不记录 prompt / 命令 / 工具输出（审计只留计数、判定名、工具名与摘要哈希）；
* 不用时间阈值判死循环（见上）；
* 不静默改写语义、不静默删数据；
* 不修另一个进程里的东西：策略/面板里的 Python 空转（例如交易所不可达时每 5–10 秒无限重试）**只能被"看见"**，真修要在那段代码里加退避与放弃阈值。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins/dsh-guard/status` | 世代、模式、阈值、事件循环滞后、每个会话的 tokens/进展/判定、陈旧 turn、团队残留 |
| GET | `/plugins/dsh-guard/audit?limit=200` | 审计尾部（JSON 行） |
| POST | `/plugins/dsh-guard/action` | `{action:'whitelist'\|'unwhitelist'\|'mode'\|'clear', session?, mode?}` |
| GET | `/plugins/dsh-guard/health` | 轻量存活 + 当前滞后 |

---

## 配置（全量示例）

```yaml
mode: advise
stateRoot: guard
tickMs: 5000
idle:      { windowMs: 600000, minTokens: 20000, minToolCalls: 8, graceMs: 180000 }
burn:      { windowMs: 600000, minTokens: 0, maxToolCalls: 2 }   # minTokens>0 才启用
repeats:   { warn: 5, critical: 10 }
refusals:  { limit: 3 }
heavy:
  tools: [workflow, ralph, subagent, subagent_fork, agent_teams_create, agent_teams_approve]
  suiteTools: [bash, pwsh, run_code]
  suitePattern: 'git clone|git worktree add|run_regression_battery|run_pytestless|--allow-panel|pytest|pnpm (test|run)|npm (test|run)|docker build'
  timeoutMs: 600000
  maxConcurrent: 1
  maxPer10Min: 3
progress:
  artifactTools: [write, edit, str_replace, str_replace_editor, apply_patch, bash, pwsh, run_code, code]
  ledgerTools: [todo_write, create_goal, update_goal, agent_teams_create_task, agent_teams_update_task, agent_teams_claim_task]
budget:    { perSessionTokens: 0, perSessionYuan: 0, perTurnMs: 0, onExceed: notify, pricing: {}, downgradeModel: '' }
heartbeat: { suspectMs: 600000, parkMs: 1800000 }
nudge:     { cooldownMs: 120000, rejectAfterNudges: 2, rejectable: [repeating, spinning, over-budget] }
liveness:  { sampleMs: 1000, keep: 120, lagWarnMs: 500, lagCriticalMs: 2000 }
selfheal:  { enabled: true, agentTeams: report }   # off | report | repair
audit:     { enabled: true, file: audit.jsonl, maxBytes: 8388608, includeArguments: false }
whitelist: []
```

配置非法时**大声失败**：写一条 error 日志并不装载任何钩子（一个阈值写错的守卫会"权威地"报告一切正常，比没有守卫更糟）。

### 自愈（`selfheal`）

启动时写入**世代标记**；上一世代留下的未关 turn 与 `agentTeams: report` 下发现的"死进程留下的 `working` 成员"都会被记入审计与 `/status`。

* `off`：不做；
* `report`（默认）：只报告；
* `repair`：额外把**死进程遗留**的成员状态由 `working` 置回 `idle`（同时写 `statusBefore` / `statusRepairedBy` / `statusRepairedAt` 便于审计与回退）。**不擅自改任务归属**——任务只报告。

---

## 测试

```bash
node test/run.mjs          # 54 条断言，无依赖、无网络、无宿主
node test/run.mjs --verbose
```

覆盖：五种判定的正例**与反例**（合法轮询不得判空转、`stalled` 永不拒绝、普通 shell 不得被限流、并行读命令不得被并发上限误杀）、重型槽位不可泄漏、处置阶梯（observe/advise/enforce）、宿主接线（世代标记、陈旧 turn、团队残留、审计脱敏、`repair` 语义、非法配置不装载）、以及**不污染仓库**。

---

## 已知边界与后续

* **进程内守卫救不了"事件循环被占死"**：那种情况下守卫自己也跑不动。真正的兜底需要一个**进程外看门狗**（独立 systemd 单元或改造 wrapper，检测 `/health` 超时后重启并让世代闸自愈状态）——插件体系做不到这一层。
* v0.2 计划：client 插件（健康条 + 一键白名单/暂停）、按 provider 定价、`burning` 阈值的真机校准、把"同一命令无限重试"的观测接到子进程输出。
* 策略侧无退避重试（Python）需要在策略代码里修，本插件只负责让它可见。
* **计数器是"进程生命周期"内的**：DSH 重启后守卫的 tokens/调用计数从 0 开始，
  所以它看不到「重启前已经烧掉的钱」。判定空转需要「它运行期间」持续消耗且无产出。
* **它救不了已经被占死的事件循环**：那种情况下守卫自己也跑不动。真正兜底需要一个
  进程外看门狗（独立 systemd 单元或改造 wrapper，探测 `/health` 超时后重启宿主）；
  插件体系与宿主同生共死，做不到这一层。
