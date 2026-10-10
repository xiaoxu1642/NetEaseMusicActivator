# 二改方案（第三期）：乐签终态判据改用成长值流水，唱片记录行退出判据

**状态：待小旭放行。** 本文件是新建交付物，未改动 `background.js`、测试、manifest 或任何现有文档。

## 0. 结论摘要

- v1.2.3 用 `sign/info` 的 `recordId>0 且 songId>0` 判「前一天有没有落签」，这个字段量的其实是**唱片记录行**，不是打卡本身。服务端有一条更慢、且会整段不出的独立流水线在写它。
- 10-09 的打卡**是成功的**：成长值流水在 10-09 00:00:04 记了「黑胶乐签每日打卡 +3」，`monthCheckInTotalDay` 已经把它算进当月累计（现值 6 = 10-05~10-10 六个打卡日）。同一天的 `sign/info`/`checkin/history/list`/卡片到 +41h 仍然无行 —— 于是扩展在 10-10 00:00:06 写出了「乐签 2026-10-09 未落签，已过当天无法补」这条**假阴性**。
- 本期把判据换成成长值流水，`fetchVipSignRecord`（读 `sign/info`）整体删除；顺带让 21:00 复核第一次变得有意义（旧条件下它每天都判定"缺行"，天天空打一次）。

## 1. 起因：10-09 被自己判成失败，服务端说它成功了

2026-10-10 17:37:08 与 17:39:13 两次只读探针（本机 tmp 下的核查脚本 + Edge 卷影副本取 Cookie，全程零写操作；脚本不在仓库内，本文只引用它读到的服务端响应原文）。

| 归属日 | 扩展打卡时刻（本地日志） | 成长值流水「黑胶乐签每日打卡」 | 流水 − 日志 | `sign/info` 唱片行 | 扩展自己写的终态 |
|---|---|---|---|---|---|
| 10-05 | 12:07:30 | 12:07:29 | −1s | `recordId=730958385` ✓ | 日志未覆盖 |
| 10-06 | 00:08:07（记录行反推） | 00:08:07 | ±0 | `recordId=732122867` ✓ | 同上 |
| 10-07 | 00:01:20 | 00:01:22 | +2.1s | `recordId=732344281` ✓ | 21:11「今日已签」 |
| 10-08 | 00:00:07 | 00:00:07 | +0.3s | `recordId=733836712` ✓ | 10-09 00:21「已落签」 |
| **10-09** | 00:00:06 + 21:00:00 补打 | **00:00:04（有）** | −1.7s | **无（`recordId=0`）** | 10-10 00:00「**未落签**」← 假阴性 |
| 10-10 | 00:00:06 | 00:00:04（有） | −1.1s | 无（待观察） | 未到终态 |

排除"流水条目是日历到点自动发的"这一反向解释：8-01~10-10 共 173 条流水，每一天都固定带一条「黑胶SVIP每日发放 +20」，而乐签条目**只出现在 10-05~10-10 这六天各一条**（另 8-29 23:47:11 一条是手签）；10-01~10-04 零条，那几天扩展还没装。→ 流水条目与打卡一一对应。

补充：10-09 打了两次（00:00 与 21:00，都 `data===true`），流水只有一条 ⇒ **服务端按天去重**，旧版 21:00 补打在"已计入"的日子里纯属空转。

## 2. 判据重定义（两个端点，别再用混）

| 用途 | 端点 | host | body | 读什么 |
|---|---|---|---|---|
| **打卡是否被计入（新判据）** | `/weapi/vipnewcenter/app/level/growth/details` | interface3.music.163.com | `{limit:"40", offset:"0"}` | `data.details[]` 里归属日当天是否有 `descript` 含「乐签」的条目；`data.hasMore` 决定翻页 |
| 月度累计天数（交叉核对） | `/weapi/vipnewcenter/app/level/user/checkin/history/detail` | 同上 | `{type:"1", signDayTime:"<当天 00:00 的 ms>"}` | `data.monthCheckInTotalDay`（当前 6）；`monthCheckInPrizList[]` 节点 7/14/28 |
| 唱片记录行（**退出判据**） | `/weapi/vipnewcenter/app/user/sign/info` | 同上 | `{}` | 慢流水线，可几十小时不出、也可能永远不出 |
| 打卡（不变） | `/weapi/vip-center-bff/task/sign` | 同上 | `{}` | `data===true` 只代表受理，不代表计入 |

一个已经踩过的坑，写在这里防止再犯：`checkin/history/detail` 的 `type=1` 返回的 `songInfo` 是**当天轮换的推荐歌**，不是记录 —— 实测 10-06 与 10-08 返回同一首 KCM《죽도록 사랑해》，而这两天真实记录的 `songId` 分别是 167873 / 34468239；`recordId` 在 `type=1` 下恒为 0。只有 `type=2&recordId=<id>` 返回真记录（10-08 → `songId=34468239`，与 `sign/info` 一致）。

## 3. 改动方案

### 3.1 新增两个纯函数（`background.js`，紧挨现有 `isoDate`/`fetchVipSignRecord` 区）

```js
// "2026-10-09" → 本地 [00:00:00.000, 次日 00:00:00.000)。Date 只有"日"粒度时会按 UTC 解析，必须拆数字构造。
function dayBounds(day) {
    const [y, m, d] = day.split("-").map(Number);
    return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

// 落签的唯一依据：成长值流水里那天有一条「黑胶乐签每日打卡」。
// sign/info 的 recordId 由另一条更慢的流水线写出，实测 10-09 已计入却到 +41h 无行，据此判过失败的假阴性。
async function hasMusicSignLedgerEntry(day) {
    const [from, to] = dayBounds(day);
    const csrfToken = await getCookie("__csrf");
    const scanned = [];
    for (let page = 0; page < LEDGER_PAGES; page++) {
        const reply = await weapiRequest(VIP_CENTER_HOST, "/weapi/vipnewcenter/app/level/growth/details",
            { limit: String(LEDGER_PAGE_SIZE), offset: String(page * LEDGER_PAGE_SIZE) }, csrfToken);
        if (reply.code !== 200) return { code: reply.code };
        const details = reply.data && Array.isArray(reply.data.details) ? reply.data.details : [];
        scanned.push(...details);
        if (!reply.data || reply.data.hasMore !== true) break;
    }
    if (scanned.some((item) => item && item.time >= from && item.time < to && String(item.descript || "").includes("乐签"))) {
        return { counted: true };
    }
    // 翻到的条目最老仍晚于目标日 ⇒ 还没覆盖到那一天，只能说证据不足，绝不写成"未计入"。
    const covered = scanned.some((item) => item && typeof item.time === "number" && item.time < from);
    return { counted: covered ? false : null };
}
```

`counted` 是三态（true / false / null），`null` 一律不判失败 —— 假阴性正是本期要修的东西，不能在新判据里留一个能产生假阴性的分支。

**不依赖倒序**：早停会要求"流水严格按时间倒序"，而这一点只是实测观察、不是协议保证；若哪天服务端改成乱序，早停会在覆盖目标日前就退出并误判"未计入"。固定翻满 `LEDGER_PAGES = 2`（80 条）后一次判定，代价是晨批多 1 个请求，换掉一个排序假设。`LEDGER_PAGE_SIZE = 40` 与探针同值，实测 10-05 那种突发日（首次运行当天 29 条）也在 80 条内覆盖得住。

### 3.2 晨批 `finalizeVipSign`（`background.js:318`）

```js
const ledger = await hasMusicSignLedgerEntry(day);
if (ledger.code !== undefined) return notLoggedIn(ledger.code, "乐签终态") || rejected(ledger.code, "乐签终态");
if (ledger.counted === null) return { done: true, message: `乐签 ${day} 无法判定：流水未覆盖当天`, details: { pages: LEDGER_PAGES } };
return ledger.counted
    ? { done: true, message: `乐签 ${day} 已计入` }
    : { done: true, message: `乐签 ${day} 未计入，已过当天无法补` };
```

措辞从「未落签」改成「未计入」，是为了让日志里的失败断言与判据强度对齐：这句话现在只会在流水真的缺条目时出现。

### 3.3 晚批 `verifyVipSign`（`background.js:330`）

复核条件从「今天没有唱片行」改成「今天流水没有乐签条目」：

```js
const ledger = await hasMusicSignLedgerEntry(isoDate(new Date()));
// 同 3.2：code/ null 分支在先，null 时不补打（补打是写操作，不能建立在证据不足上）
if (ledger.counted === true) return { done: true, message: "乐签复核：今日已计入" };
if (ledger.counted === null) return { done: true, message: "乐签复核：流水未覆盖当天，暂不补打" };
const punch = await requestVipSignPunch();
…
return { done: true, message: "乐签复核：今日流水无乐签条目，已补打，终态次日核对", details: { punchAck: punch.data === true } };
```

为什么保留补打而不是删掉晚批任务（另一个候选）：`signVipMusic` 在 `code===200 且 data!==true` 时返回 `done:true`，会**写当天日期门**（`runBatch` 见 `background.js:467`），晨批从此当天不再重试；这条路径只有 21:00 的复核能兜住。旧版它兜不住是因为判据恒真（唱片行白天基本不出现），每天无差别补打；换成流水后，"受理了却没计入"才第一次成为它能识别的真实缺口。删掉晚批 = 把这个缺口敞着。

### 3.4 删除 `fetchVipSignRecord`（`background.js:299-306`）及其 `sign/info` 调用

扩展对唱片记录行做不了任何事（10-09 打了两次也没催出行），保留它只会再次产生假阴性。记录行的观察交给仓库外的探针脚本，不进扩展。

## 4. 请求成本

晨批 +1~2 次 `growth/details`（替代原来 1 次 `sign/info`），晚批 +2 次（替代 1 次）。全部命中已有 host 权限 `*://*.music.163.com/*`（`manifest.base.json:25-28` 已核对），**manifest 无需改动**。

## 5. 日界与时钟抖动（已量化）

流水的 `time` 是服务端毫秒时刻，与本地日志差值实测在 **±2.1s** 内（见第 1 节表列）。取数不加 padding，理由是：晨批打卡固定在 00:00:05（`scheduleNextRun`，`background.js:182`），条目要落到前一天需要服务端比本机慢 5s 以上；而晨批终态在次日打卡**之前**执行，所以当天的新条目不可能混进昨天的窗口。风险与失效形态记在未验项 #4。

## 6. 改动点清单（落地阶段执行）

| 文件 | 动作 | 内容 |
|---|---|---|
| `background.js` | 改 | 新增 `dayBounds`、`hasMusicSignLedgerEntry`、两个常量；`finalizeVipSign`/`verifyVipSign` 换判据；删 `fetchVipSignRecord`；顶部注释里"记录行要几小时后才写出""唯一判据"等已证伪表述更正 |
| `manifest.base.json` | 改 | `version` 1.2.3 → 1.2.4（`build.js` 产出 `dist/chrome`） |
| `tests/orchestration.test.mjs` | 改 | 新桩件 `LEDGER_COUNTED` / `LEDGER_COVERED_EMPTY` / `LEDGER_NOT_COVERED`；`ALL_OK` 加流水路由（harness 对未桩件化的请求直接 throw，见 `tests/orchestration.test.mjs:128`）；删掉只服务旧判据的 `SIGN_INFO_*` 断言 |
| `README.md` | 改 | 乐签一段的判据措辞 |
| `PLAN-signin-vip.md:78`、`PLAN-evening-batch.md` 末尾 | 改 | 给「唯一判据 = `recordId>0`」那两处加更正标注（保留原文与日期，不改写历史叙述） |

## 7. 验证策略（离线为主）

新增/改写 7 条用例：

1. 晨批流水有当天条目 → 「已计入」，并断言 `calls` 里**没有** `user/sign/info`（锁死旧判据回归）。
2. 晨批流水覆盖到当天之前却无条目 → 「未计入，已过当天无法补」。
3. 晨批 80 条全部晚于目标日 → 「无法判定」，且措辞里不得出现「未计入」。
4. 晚批今日有条目 → 只读，断言 `calls` 里**没有** `task/sign`（这条就是 10-09 空打的回归锁）。
5. 晚批今日无条目但已覆盖 → 补打一次，`punchAck` 进 details。
6. 晚批无法判定 → 不补打。
7. `growth/details` 返回非 200 → 走 `notLoggedIn`/`rejected`，不写日期门（沿用既有瞬态约定）。

反向验证（改前必须做，证明用例真能判据）：把 `includes("乐签")` 故意改成 `includes("签到")` → 用例 1、4 应变红；把窗口改成 `item.time >= from - 86400000` → 用例 2、4 应变红。报告里要带上变红时的具体报错文本，不接受"跑过了"。

真机：`dist/chrome` 重载后，10-11 00:00 的晨批给 10-10 出终态；次日 09:35 的自动化核对做交叉（它读的是探针，正好与扩展的判据互相独立）。发版按惯例 commit → push → tag `v1.2.4` + release 附 zip，push 前过一遍脱敏（仓库是 PUBLIC）。

## 8. 未验项清单（一次列清，不逐条追问）

| # | 项 | 现状 | 何时/怎么验 |
|---|---|---|---|
| 1 | `descript` 文案「黑胶乐签每日打卡」是否长期稳定 | 只在 6 天样本里稳定；靠它匹配，文案若改名会退化成"未计入"假阴性 | 每次探针核对顺带看；改名风险靠"连续多天报未计入而 `monthCheckInTotalDay` 在涨"识别 |
| 2 | `limit`/`offset` 传数字是否与字符串等价 | 实测字符串可用；weapi 编码成 form 后大概率等价 | 落地时保持字符串，不做二次验证 |
| 3 | 80 条上限是否总够覆盖目标日 | 日常每天 1~3 条，够；首次运行那天 29 条 | 三态里的 `null` 就是兜底，会写「无法判定」而不是误判失败 |
| 4 | 服务端比本机慢 >5s 时条目落到前一天 | 实测 ±2.1s | 若哪天把打卡时刻挪到 23:5x，需重估本节 |
| 5 | 7 天节点奖（`monthCheckInPrizList` day=7 → 成长值 30）是否被晚批现有 `task/reward/getall` 覆盖 | 未知；当前 `monthCheckInTotalDay=6`、所有 `userPrizeRecordId=0` | 明天累计到 7 时复跑本机只读探针对照 `checkin/history/detail`，必要时另开一期 |
| 6 | 10-09 的唱片记录行会不会最终补出 | 不影响本期（扩展已不再对它动作） | 交给自动化观察 |

## 附录 A：本期实测到的响应形态

```
growth/details → {"code":200,"message":"success","data":{"hasMore":true,"details":[
  {"descript":"黑胶乐签每日打卡","growthPoint":3,"time":1791475204320,"resourceId":0},
  {"descript":"黑胶SVIP每日发放","growthPoint":20,"time":1791494717270,"resourceId":168404218}, …]}}
checkin/history/detail(type=1) → data.monthCheckInTotalDay=6, recordId=0,
  monthCheckInPrizList=[{day:7,prizeShowName:"成长值",unitNum:30,userPrizeRecordId:0},
                        {day:14,…60},{day:28,…SVIP3天}], sceneId=66,
  periodDto={periodType:3,startTime:"1722527999000",endTime:"1893427199000"}
```

## 附录 B：参考实现索引

- Go `netease-cloud-music-master/api/weapi/vip.go:1294-1325`（`VipTaskSign`，响应 `RespCommon[bool]`、可选 `?isNew=`）、`:1365-1449`（`checkin/history/detail` 请求约束：`type=1` 必带 `signDayTime`、`type=2` 必带 `recordId`）、`:1348-1363`（`checkin/history/list`）
- Go `api/vip_sign_test.go:238-262`（客户端真实调用序列与参数形态）
- Node `NeteaseMusic-API-main/module/vip_sign.js:7`（打卡 = `/api/vip-center-bff/task/sign`）、`module/vip_sign_info.js:7`、`module/vip_growthpoint_details.js:10`（流水端点；`:6-7` 是它 `limit` 20 / `offset` 0 的默认值）
