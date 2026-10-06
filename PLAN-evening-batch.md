# 二改方案（第二期）：晚间批扩展 —— 云贝任务奖励一键领取 + 乐签复核补打

> 状态：**方案待评审**。本文件只做设计说明，落地前不改动任何源文件。
> 上一期方案见 `PLAN-signin-vip.md`（每日签到 / 云贝签到+连签阶段奖 / 黑胶乐签 / 成长值一键领取，P0–P2 已实现）。
> 本期全部改动仍然落在 `background.js` + 离线测试，**不新增权限、不新增依赖、不新增闹钟**。

---

## 1. 起因：一次真机运行诊断（2026-10-06）

从扩展自身的 `runtimeLogs` + `chrome.storage.local` 快照（2026-10-06 17:26 读取）得到的事实：

| 任务 | 2026-10-06 00:08 晨批实际结果 |
|---|---|
| 每日签到 | ✅ `每日签到成功 {point:2}`，日期门更新为 10-06 |
| 云贝签到 | ✅ 返回 `data.sign === true`（**全新签到**，非"已签"），服务端已计入 10-06 |
| 云贝连签奖励 | 当时无待领 |
| 黑胶乐签 | ⚠️ 接口返回 `data:true`，**但客户端同时段日历显示当日未签**（前一日已签、今日日历空、打卡按钮仍可点） |
| VIP 成长值 | 10-05 晚窗口已领取成功；10-06 21:00 窗口已排定 |

由此得出两个结论：

1. **乐签在凌晨打卡不可靠**。接口给了成功响应，但当日打卡没有生效。倾向解释：网易乐签的"签到日"边界晚于本地 00:08，凌晨打卡被算进前一天（也可能是客户端展示延迟，但两者都指向同一个修法）。现有实现把乐签放在晨批（00:00:05 触发），属于"响应成功即真"的错误假设。
2. **云贝签到本身没问题**（00:08 的全新签到被服务端正确计入当天），客户端里"看起来没签"的部分是历史缺签记录，与扩展无关。

用户侧提出的两点诉求（已确认口径）：

- **新增「云贝任务奖励一键领取」**：手游/客户端上「听漫游 300 云贝 一键领取」这类**每日任务奖励**，白天攒进度、晚上一次性领掉；与 VIP 成长值一键领取放在**同一时刻触发**。云贝签到保持凌晨不动。
- **乐签修复走"凌晨试打 + 晚间复核补打"**：凌晨照旧试打（保留冗余），晚间 21:00 后用状态接口复核，没签上就补打一次。

---

## 2. 方案总览

```
晨批（每天首次运行触发，沿用现状，不变）
  ├─ dailyTask      每日签到
  ├─ yunbeiSign     云贝签到          ← 不动（00:08 全新签到已实证计入当天）
  ├─ yunbeiStage    云贝连签阶段奖
  └─ vipSign        乐签「试打」      ← 文案降调，不再宣称终态成功

晚批（本地 21:00–23:59，沿用现有窗口，与成长值领取同批）
  ├─ vipSignCheck   乐签复核 + 补打   ← 新
  ├─ yunbeiTask     云贝任务奖励一键领取 ← 新
  └─ vipGrowth      VIP 成长值一键领取（不动）
```

设计要点：

- **零新调度机制**：不新增 alarm，不新增窗口。晚批沿用 `netEaseVipGrowthClaim` 闹钟与 21:00–23:59 硬窗口，只是往批里加任务。这正是"和 vip 一键领取一块触发"的字面实现。
- **不加新账目**：`vipGrowthLog` 保持原样，不为新任务建第二个账目数组；每任务的"今天是否已完成"仍走 `taskDoneOn` 日期门，过程细节留在 `runtimeLogs`。
- **不模拟任何用户行为**：只领"已完成"的任务奖励，不做听歌 / 看视频 / 打开 App 的模拟 —— 与一期方案 §3 的边界立场一致（风险控制动作只做聚合领取，且每天每任务最多一次）。
- **隐私不扩容**：新增日志只记数量（`{claimed, total}`），不记录任务名、金额明细、歌曲信息，符合 README 既有隐私声明。

---

## 3. 新任务一：云贝任务奖励一键领取（`yunbeiTask`，晚批）

### 3.1 接口链（双参考对齐）

| 步 | Host | 路径 | 请求体 | 判定 |
|---|---|---|---|---|
| ① 列表 | `music.163.com` | `/weapi/usertool/task/todo/query` | `{}` | `code===200`；`data[]` 每条含 `completed / period / userTaskId / depositCode / taskPoint / taskName` |
| ② 领取 | `music.163.com` | `/weapi/usertool/task/point/receive` | `{"period":"<p>","userTaskId":"<id>","depositCode":"<code>"}`（全部字符串） | `code===200 && data===true` 视为领取成功 |

依据：Go `api/weapi/yunbei.go:583-650`（`YunBeiTaskTodo` / `YunBeiTaskFinish`，其注释明确"一次只能领取一个，网易一键领取是调用了多次该接口实现"，来自官方客户端 HAR 抓包）；Node 参考 `module/yunbei_tasks_todo.js`、`module/yunbei_task_finish.js`（同为 weapi 路径，确认 `todo/query` 空体、`point/receive` 需 `userTaskId` + `depositCode`）。

**参数差异的处理（已定决策）**：Go 版发三字段（含 `period`），Node 版只发两字段（`depositCode` 缺省 `'0'`）。本方案按 **Go 三字段**实现（HAR 来源、更接近客户端原样）；若真机首轮发现接口拒绝，退到 Node 两字段形态（一行改动）。

### 3.2 行为

```
读取 todo 列表
  ├─ 状态码 301        → 按未登录处理（中止本批 + 登录提醒，沿用现有机制）
  ├─ 其他非 200        → 记日志、写日期门、不重试
  ├─ 无 completed 项   → 日志「云贝任务：无待领」，写日期门
  └─ 有 N 个 completed → 逐个调用 receive：
        · data===true   → 计入已领
        · 其余情况      → 计入失败（不中断循环）
     日志「云贝任务：已领取 X/N 项」，写日期门
```

- **日期门**：`taskDoneOn.yunbeiTask = <today>`，语义与现有任务一致 —— 只要这一轮跑出了明确结论（含"无待领"），当天不再重复请求。
- **瞬态异常**（网络错误 / 解析失败）不写门，留给当晚下一次触发或次日重试，与现有 `runBatch` 的异常处理完全同构。
- **已知边界**：21:00 "无待领"之后又在 22:30 完成的新任务，当晚不会再领（每天每任务一次的设计约束，成长值领取同款取舍）。

## 4. 新任务二：乐签复核 + 补打（`vipSignCheck`，晚批）

### 4.1 接口

| 步 | Host | 路径 | 请求体 | 判定 |
|---|---|---|---|---|
| ① 复核 | `interface3.music.163.com` | `/weapi/vipnewcenter/app/user/sign/info` | `{}` | `code===200`；`data[]` 中任一 `today===true` 即"今日已签"（约返回近 7 天记录） |
| ② 补打 | `interface3.music.163.com` | `/weapi/vip-center-bff/task/sign` | `{}` | 与晨批同一接口、同一判定（`data===true`） |

依据：Go `api/weapi/vip.go:568-605`（`VipSignInfo`，`Today` 字段注释"是否今天签到"）；一期方案附录 A 已登记该端点，本期是首次实调用。

### 4.2 行为

```
读 sign/info
  ├─ 301 / 非 200        → 未登录提醒 / 记日志写门（不重试）
  ├─ 任一 today===true   → 日志「乐签复核：今日已签」          （不补打）
  └─ 无 today           → 补打一次：
        · data===true    → 日志「乐签复核：未生效，已补打成功」
        · 其余           → 日志「乐签复核：补打未完成」+ 原因文案
      写日期门
```

- **为什么复核机制不依赖"边界几点"**：无论乐签的签到日是 00:00 还是 06:00 边界，晚间 21:00 都远在其后；"读状态 → 仅当缺口存在才写"的逻辑对边界时刻免疫。这正是选它而不是"猜一个安全小时"的原因。
- **晨批文案调整**：`signVipMusic` 成功时的日志由「乐签成功」改为「乐签：打卡请求成功」（语义降级为"请求已受理"），终态判断交给晚间复核 —— 避免日志再次出现"接口说成功、日历说没签"的误报。
- **补打结果不做二次读确认**（决策点）：晚间时刻远超已知边界，`data:true` 在此刻可信；若首轮真机日志出现"补打成功但次日日历仍缺"，再加一次复核后读（约 6 行，预案保留）。
- **每天最多两次打卡请求**（晨批试打 + 晚批补打），两次各有独立日期门，不会无限重试。

## 5. 调度层改动（现有代码的最小扩展）

1. `TASKS` 注册表新增两行：

```js
{ key: "vipSignCheck", batch: "night",  run: verifyVipSign },
{ key: "yunbeiTask",   batch: "night",  run: claimYunbeiTasks },
```

2. `shouldRunNight` 判定从"只看 `vipGrowth` 门"改为"**晚批任一任务未完成即应运行**"：

```js
function shouldRunNight(now, doneOn) {
    if (now.getHours() < VIP_CLAIM_HOUR) return false;
    const today = localDate(now);
    return TASKS.filter(t => t.batch === "night").some(t => doneOn[t.key] !== today);
}
```

修掉一个现存边角：现在如果 `vipGrowth` 已领、而其他晚批任务因瞬态失败缺门，当晚不会再触发；改后任一缺门都会继续触发（已完成的靠各任务自己的门跳过）。

3. 闹钟名与窗口**保持不动**（`netEaseVipGrowthClaim` + 21:00–23:59）：改名只影响措辞，但要引入一次性兼容分支，不值得；只把调度日志从 `Next VIP growth claim scheduled at` 改为 `Next evening batch scheduled at`（纯文案）。

4. 晨批 `runBatch` / 异常处理 / 登录提醒 / 并发闸门（`batchInFlight` + `rerunRequested`）全部不动。

---

## 6. 改动点清单（落地阶段执行，本方案不动任何文件）

| 文件 | 动作 | 内容 |
|---|---|---|
| `background.js` | 改 | `signVipMusic` 成功文案降调；新增 `verifyVipSign()`、`claimYunbeiTasks()`；`TASKS` 加两行；`shouldRunNight` 改为"晚批任一未完成"；`scheduleVipClaim` 的日志文案。约 +60 行 |
| `tests/orchestration.test.mjs` | 改 | 新增 3 个桩件（`todo/query`、`point/receive`、`sign/info`）× 多分支；新增用例见 §7；更新受影响的调用计数与日期门断言；并发用例的端点清单扩容；顺手把文件头注释的跑法从 `node --test tests/` 改为 `node --test`（本机 Node 25 下带目录参数会报 `MODULE_NOT_FOUND`，仓库根无参运行可用） |
| `manifest.base.json` | 只改版本号 | `1.1.0 → 1.2.0`；权限一字不动（`*://*.music.163.com/*` 已覆盖全部新端点） |
| `README.md` | 改 | 功能表加"云贝任务奖励一键领取"；「黑胶乐签」一条补充"晚间复核补打"；使用说明的晚间窗口描述从"成长值"扩为"晚间批"；隐私说明无需改动（无新数据项） |
| `PLAN-evening-batch.md` | 新增 | 本文件（脱敏后入库） |

**明确不做（防止范围蔓延）**：

- **补签（10/03、10/04 这类历史缺签）不做**：补签要消耗云贝/补签卡且属于额外账号动作，非本次诉求；需要时在客户端手动补。
- **自动完成"听漫游/看视频/打开应用"等任务本身不做**：扩展只领已完成的，不模拟任何用户行为（同上期 §3 的边界立场）。
- **满勤抽奖 `extraLotteryId` 仍然不做**（一期方案 §8 未验项 5，Go 侧同样 Pending）。
- **popup 面板（P3）仍然推迟**。

---

## 7. 验证策略（离线为主，不需要人工眼验）

沿用一期的离线测试台（`tests/orchestration.test.mjs`，vm 上下文 + chrome/fetch 桩件，`node --test`）：

**新增用例**

1. **窗口外（09:30）零新请求**：不出现 `usertool/*` 与 `sign/info` 调用；晨批请求数保持 4（含乐签试打）。
2. **窗口内（21:30）整批**：`sign/info`、`todo/query`、`point/receive`、`reward/getall` 各按预期调用；`vipSignCheck / yunbeiTask / vipGrowth` 三个日期门全部落为当天。
3. **复核已签不补打**：`sign/info` 返回 `today:true` → 晚批中该接口只打一次，不再调用 `vip-center-bff/task/sign`。
4. **复核未签补打一次**：`sign/info` 返回无 `today` → 恰好补打一次；补打失败也只记一次。
5. **云贝任务只领 completed**：列表 3 条（2 条 completed）→ `point/receive` 恰好 2 次；全非 completed → 0 次、日志"无待领"。
6. **瞬态失败不写门**：`todo/query` 抛一次网络错 → 不写 `yunbeiTask` 门；下一次触发重试。
7. **晚批任一缺门即触发**：`vipGrowth` 已领但 `vipSignCheck` 缺门 → 21:30 触发时晚批仍运行（且只补缺的）。
8. **并发触发**：现有并发用例的端点清单加上 3 个新端点，每个全天仍只打一次。

**真机一轮（落地后从扩展自身 `runtimeLogs` 读取结论，不要求人工盯屏）**：观察 21:00 批是否出现「乐签复核：今日已签 / 已补打」与「云贝任务：已领取 X/N 项」；客户端次日核对乐签日历与云贝到账。

**完成检查**：`node build.js` 通过、`node --test`（仓库根）全绿（基线 18 项 + 新增 5 项，共 23 项）、`git diff --check` 干净、dump 新增日志 details 确认无 cookie/`__csrf`/密文/任务名。

---

## 8. 未验项清单（一次性列清，不逐条追问）

| # | 未验项 | 影响 | 处理 |
|---|---|---|---|
| 1 | 乐签签到日边界的确切时刻（目前只知道晚于本地 00:08） | 曾是 bug 根因 | 设计上规避：复核机制不依赖具体时刻（§4.2） |
| 2 | `/weapi/usertool/task/todo/query` 的真实响应形态（字段是否与 Go/Node 双参考一致；已领条目是否仍在列表） | 领取计数与容错 | 按双参考实现；非 `completed` 一律跳过、`receive` 非 true 只计失败不中断。真机首轮日志可确认，误判无副作用 |
| 3 | `point/receive` 的参数集合（Go 三字段 vs Node 两字段） | 领取是否被受理 | 按 Go 三字段；真机被拒则一行退到 Node 形态 |
| 4 | "听漫游"等任务完成条件与出现时机（是否要在客户端做过动作才进列表） | 无（扩展只领已完成的） | 真机日志观察即可；任务未出现 = "无待领"，行为正确 |
| 5 | 21:00 补打后是否 100% 落到当天日历 | 极端边界 | 晚间时刻远超已知边界，理论可信；若首轮出现偏差，按 §4.2 预案加复核后读 |
| 6 | 整晚浏览器未开 → 当天乐签复核缺失 | 断签一天 | 与成长值窗口同款约束；成长值可累积、签到类不可 —— 属用户已知并接受的取舍（一期 §9 立场延续） |

---

## 附录 A：本期新增/实调用的端点

| Host | 路径 | 请求体 | 用途 |
|---|---|---|---|
| `music.163.com` | `/weapi/usertool/task/todo/query` | `{}` | 云贝任务列表（新） |
| `music.163.com` | `/weapi/usertool/task/point/receive` | `{"period","userTaskId","depositCode"}` | 领取单个已完成任务奖励（新，逐个调用） |
| `interface3.music.163.com` | `/weapi/vipnewcenter/app/user/sign/info` | `{}` | 乐签状态复核（本期首次实调用） |

全部 host 由现有 `host_permissions` 覆盖，无需改 manifest 权限。

## 附录 B：参考实现索引（本期新增部分）

| 主题 | 位置 |
|---|---|
| 云贝任务列表 / 领奖（HAR 来源，含"一键领取=多次调用"注释） | `netease-cloud-music-master/api/weapi/yunbei.go:583-650` |
| 官方签到编排中的云贝任务领取顺序 | `netease-cloud-music-master/internal/ncmctl/sign.go:288-316`（`yunbeiClaim`，在云贝签到之后、成长值领取之前） |
| 乐签状态结构体（`today` 字段语义） | `netease-cloud-music-master/api/weapi/vip.go:568-605` |
| Node 侧同端点（参数形态与默认值） | `NeteaseMusic-API-main/module/yunbei_tasks_todo.js`、`module/yunbei_task_finish.js`、`module/vip_sign_info.js` |

## 附录 C：诊断证据留档（2026-10-06 真机）

- 2026-10-06 00:08 晨批：`每日签到成功 {point:2}` / `云贝签到成功` / `云贝连签奖励：无待领` / `乐签成功`；`taskDoneOn` 四个晨批键全部推进到 10-06。
- 同日 17:26 客户端：乐签日历 10-05 已签、10-06 未签、打卡按钮可点 —— 与晨批"乐签成功"矛盾，判定为"凌晨打卡未落到当天"。
- 10-05 22:56：`VIP 成长值：领取成功`（时间窗功能真机验证）。
