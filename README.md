# NetEaseMusicActivator

[English Version](#english)

## 简体中文

网易云音乐每日自动签到，后台静默运行，不打扰日常浏览体验。

适合海外用户搭配 [NetEaseMusicWorld++](https://github.com/kogamitora/NetEaseMusicWorldNext) (Chrome / Chromium) 或 [NetEaseMusicWorld+](https://github.com/nondanee/NetEaseMusicWorldPlus) (Firefox) 使用，每日刷新歌曲播放权限，手机电脑等客户端也将同步解锁。

## 二改说明

本仓库是 [cmxin24/NetEaseMusicActivator](https://github.com/cmxin24/NetEaseMusicActivator) 的 fork，在上游「每日签到」的基础上增加了：

| 新增 | 说明 |
|---|---|
| 云贝中心签到 + 连续签到阶段奖励 | 除原有 `/api/point/dailyTask` 外，另走 `pointmall/user/sign` 完成云贝签到，并自动领取已达标（3 / 7 / 28 天）的阶段奖励 |
| 黑胶乐签 | 打卡走 `vip-center-bff/task/sign` 的 weapi 加密请求，无会员权益也可签到；是否计入以成长值流水（`level/growth/details`）里当天那条 `黑胶乐签每日打卡`(+3) 为准（「黑胶乐签阶梯奖励 +30」同秒出现但不是打卡，不计入），21:00 后若当天流水还没有该条目则补打一次，终态由次日晨批按同一条判据给出。流水没读到尽头时只说「无法判定」，既不写未计入也不补打 |
| 云贝任务奖励一键领取 | 走 `usertool/task/todo/query` + `usertool/task/point/receive`，在 21:00–23:59 与成长值同批领取已完成的任务奖励（如听漫游），只领已完成项、不代做任务 |
| VIP 成长值一键领取 | 走 `vipnewcenter/app/level/task/reward/getall`，只在本地时间 21:00–23:59 触发、每天最多一次 |
| weapi 加密层 | 上述接口只接受密文。`weapi.js` 用 WebCrypto（AES-128-CBC）+ BigInt 裸 RSA 自实现。**零第三方依赖**，不引入 crypto-js / node-forge |
| 离线测试 | `node --test`：加密层与独立实现逐字节比对，调度门控用桩件验证 |

两点取舍需要说明：

- **只产出 Chromium / Edge 构建**。Firefox 的构建分支已移除，addons.mozilla.org 上仍是上游旧版，不含上述功能。
- **为什么晚间批定在 21:00 之后**。云贝任务奖励与成长值都要等白天攒进度，白天去领往往无值可领。乐签的「是否计入」看成长值流水：晨批那次打卡即使回了 `data:true`，也可能没换成流水里的一条 `黑胶乐签每日打卡`；21:00 若当天还没有这条条目就是真没计入，补打是当天唯一的修复机会（实测 10-09 打了两次，流水只记一条，据此认为服务端按天去重、补打不会重复加分 —— 这是**观察，不是协议保证**）。判据是三态而不是两态：流水翻到尽头（`hasMore` 不为 true）或条目时间跨度越过那一天，才允许写「未计入」；两者都拿不到就写「无法判定」，既不宣布失败也不发补打。注意 `sign/info` 里那天的**唱片记录行**是另一条更慢、且会整段不出的流水线，实测已证伪它作为判据（10-09 流水 00:00:04 已计 +3、当月累计天数也已含它，记录行到 +41h 仍为 0），扩展不再读它。所以这三项的**首次**触发都在 21:00–23:59，每天各一次；晚批还有没落门的任务时（瞬态失败或接口拒绝），当晚每 20 分钟再排一次，把窗口内的修复机会用完，全部落门才顺延次日。错过当晚（浏览器那段时间没开）不再等于干等 24 小时：晚批的日期门按「哪一个晚上」归属（21:00 之前算刚过完的那个晚上），次日任何一次唤醒都会把**两个领取类任务**补跑掉，而补跑写的门落回那个晚上，不会把当晚的正常批挤掉。**乐签复核/补打不参与补跑**——过了午夜那一天就补不了了，它仍然只在当天窗口内运行，漏一晚即断签一天。

许可证沿用上游的 GPL-3.0，二改代码同样以 GPL-3.0 开源。

## 主要功能

- **每日签到**：自动完成网页端签到与云贝中心签到，并领取已达标的连续签到奖励（3 天 / 7 天 / 28 天）。判据只认两种正面证据：本次请求拿到 `code:200`，或云贝明确回 `sign:false`（文档化的「重复签到」）。`/api/point/dailyTask` 的 `-2` **不再被当成「今日已签」**——这个端点在两个参考协议实现里都没有文档，语义无从核对，所以按接口拒绝处理：不落当天日期门、把服务端的 `message` 原样写进日志、下次触发再试。同理，读不到 `sign` 字段（`data` 缺失、响应形态不对）也不是「已签」，是「本轮没有结论」。另外，`__csrf` 读不到时**一个写请求都不发**：缺 token 的答复曾被读成「今日已签」并落门，结果是当天两个签到其实都没打成，而扩展一整天不再重试。
- **黑胶乐签**：自动完成「黑胶乐签」打卡（`vip-center-bff/task/sign`），无会员权益也可签到；晚间 21:00 后若当天成长值流水还没有 `黑胶乐签每日打卡`(+3) 条目则补打一次，终态由次日晨批按同一条判据给出。流水证据不足时报「无法判定」并保持当天可重试，本机没参与过的那一天报「未参与打卡」，都不会被写成漏签事故。
- **云贝任务奖励一键领取**：每天 21:00–23:59 把已完成的云贝任务奖励（如听漫游）逐个领取，只领已完成项，不代做任务本身；错过当晚会在次日首次唤醒时补领。
- **VIP 成长值一键领取**：每天 21:00–23:59 之间领取已完成的成长任务奖励，每天只调用一次。成长值不过期，错过当晚会在次日首次唤醒时补领。
- **登录提醒**：如果用户尚未登录，将发送一条通知进行提醒，点击跳转至后台已打开的网页。
- **定时执行**：如果浏览器未打开或处于休眠状态，将在下一次打开时执行；当天窗口内若还有任务没拿到结论，会每 20 分钟再排一次。
- **后台运行**：签到过程在后台静默完成，完成后自动关闭网页。

## 安装方法

Chromium内核浏览器用户请点击下方链接跳转至Chrome Web Store, 点击右侧蓝色按钮「添加到XXX」即可（XXX为您的浏览器，如Chrome或者Brave等）。

[Chrome应用商店](https://chromewebstore.google.com/detail/neteasemusicactivator/blmpkmpldchiiecilhgpahegoibafgci)

> 商店里的是上游版本，只有每日签到。本 fork 新增的乐签 / 云贝 / 成长值需要自行 `node build.js` 后以「开启开发者模式 - 加载解压缩的扩展」方式安装。

不会用 Node 的话，本仓库 [Releases](https://github.com/xiaoxu1642/NetEaseMusicActivator/releases) 页每个版本附打包好的 `NetEaseMusicActivator-v<版本>.zip`（含 `manifest.json` 与 `LICENSE`），解压即为可加载的扩展目录，安装方式同上；zip 的构建过程见「开发」一节。

Firefox用户请点击下方链接跳转至Firefox Add-ons Store, 点击右侧蓝色按钮「Add to Firefox」即可，此为旧版，有需要也可以提交issue交由我开发。

[Firefox Add-ons Store](https://addons.mozilla.org/zh-CN/firefox/addon/neteasemusicactivator/)

## 使用说明

1. **登录账号**：先在 [网易云音乐官网 (music.163.com)](https://music.163.com/) 中**登录**您的账号。
2. **自动运行**：扩展程序会自动读取您的登录状态（Cookies），并在后台自动进行每日的签到任务。
3. **晚间批时间**：乐签复核补打、云贝任务奖励领取、成长值领取都在 21:00–23:59 之间进行（云贝签到与乐签的首次打卡仍在每天首次运行扩展时完成）；这段时间内浏览器需要处于打开状态。只要还有任务没拿到结论，扩展会在窗口内每 20 分钟再排一次，全部落门才顺延次日。错过当晚时，**成长值与云贝任务奖励会在次日扩展第一次醒来时补领**（不需要等到下一个 21:00）；乐签复核不参与补跑，漏签一晚无法补。
4. **状态切换**：不需要时点击logo即可停用，logo将自动切换为灰色。

## 隐私说明

1. 不收集、不存储、也不传输用户的任何个人身份信息、听歌记录或隐私数据到任何外部服务器。

1. 所有网络请求只发往代码实际调用的 3 个主机：`music.163.com`、`interface.music.163.com`、`interface3.music.163.com`，`host_permissions` 也就只声明这 3 条精确 pattern；扩展不包含任何统计、广告或更新检查代码。

1. 本地 `storage.local` 只保存 4 类键：开关状态 `isEnabled`、各任务的「今天是否已完成」日期 `taskDoneOn`、领取账目 `vipGrowthLog`、最近 7 天的运行日志 `runtimeLogs`。领取账目只记日期与是否成功；运行日志的内容是各任务的中文结论（如「云贝任务：已领取 1/1 项」）和少量计数，单条有字节上限，服务端返回的自由文本会被截断。Cookie（`MUSIC_U`、`__csrf`）、任务名称、歌曲与听歌历史一律不落盘，日志在扩展的 service worker 控制台里查看。

1. 申请的权限仅用于实现核心功能.

1. 所有代码依照GPL-3.0开源。

## 开发

需要 Node ≥ 20（`node --test` 的稳定形态自 20 起；`build.js` 用的 `fs.cpSync` 只要 ≥ 16.7）。仓库零第三方依赖，没有 `package.json`。

```bash
node build.js                     # 生成 dist/chrome；在 edge://extensions 打开开发者模式，「加载解压缩的扩展」选它
node --test                       # 离线测试：weapi 加密层等价比对 + 调度门控行为，不联网
node scripts/gate.mjs             # 门禁：Asia/Shanghai 与 UTC 各跑一遍，并且要求 fail=0、skipped=0
node scripts/check-reference-crypto.mjs   # 可选：把 weapi 常量与本机只读参考仓库对账（缺目录即失败，所以不是测试）
pwsh -NoProfile -File scripts/pack.ps1    # dist/chrome → docs/NetEaseMusicActivator-v<版本>.zip，包内容缺件即失败
node scripts/pre-release.mjs --tag v<版本> # 发版对账：产物 ↔ 源码 ↔ 版本 ↔ tag，锚点是 blob 哈希
```

`build.js` 的 `ASSETS_TO_COPY` 是产物内容的唯一真源：清单里声明的文件必须全部进包，多了或少了都 throw（构建进 `dist/chrome.staging`，完整了才换掉 `dist/chrome`，所以不会把正在被 Edge 加载的目录先删空）。`.gitattributes` 固定 LF 换行，否则同一次 checkout 在不同机器上字节不同、发布包不可复现。

新增接口需要加密时：weapi 统一走 `weapi.js` 的 `weapiRequest(host, path, data, csrfToken)`（第 5 个形参 `query` 已删，没有任何调用点用过它）。本仓库只做 weapi，不实现 eapi（它要额外伪造一批设备身份 cookie）。已实现的端点与触发时机见 `background.js` 的 `TASKS` 表。二改的协议调研、接口清单与设计取舍记录在 `PLAN-signin-vip.md`、`PLAN-evening-batch.md` 与 `PLAN-musicsign-verdict.md`（乐签计入判据的三态契约与证伪过程）。

---

## English

NetEase Cloud Music daily auto check-in, running silently in the background without disturbing your daily browsing experience. Suitable for overseas users in combination with [NetEaseMusicWorld++](https://github.com/kogamitora/NetEaseMusicWorldNext) (Chrome / Chromium) or [NetEaseMusicWorld+](https://github.com/nondanee/NetEaseMusicWorldPlus) (Firefox), the mobile and PC client will also be unlocked synchronously.

## About This Fork

This repository is a fork of [cmxin24/NetEaseMusicActivator](https://github.com/cmxin24/NetEaseMusicActivator). On top of the upstream daily check-in it adds:

| Addition | Details |
|---|---|
| YunBei center check-in + stage rewards | Besides the original `/api/point/dailyTask`, it also calls `pointmall/user/sign` and claims the consecutive sign-in rewards (3 / 7 / 28 days) once reached |
| Vinyl Music Sign | Punches in through the encrypted `vip-center-bff/task/sign` weapi call; works without a VIP entitlement. Whether a day actually counted is judged by that day's `黑胶乐签每日打卡` (+3) entry in the growth-point ledger (`level/growth/details`) — the same-second `黑胶乐签阶梯奖励 +30` prize is not a punch and does not count. After 21:00 it re-punches once only when today's ledger entry is still missing, and the next morning reports the final verdict for the day that just ended |
| YunBei task rewards | Claims completed YunBei task rewards (e.g. Listen-to-Roaming) through `usertool/task/todo/query` + `usertool/task/point/receive`, one by one, in the 21:00–23:59 batch; only claims finished tasks, never performs them |
| VIP growth points | Claims everything pending through `vipnewcenter/app/level/task/reward/getall`, only between 21:00–23:59 local time, at most once per day |
| weapi crypto layer | Those endpoints only accept encrypted payloads. `weapi.js` uses WebCrypto (AES-128-CBC) plus BigInt raw RSA, implemented in-house. **No third-party dependencies**, no crypto-js / node-forge |
| Offline tests | `node --test`: byte-for-byte comparison of the crypto layer against an independent implementation, plus stubbed scheduling assertions |

Two deliberate trade-offs:

- **Chromium / Edge builds only.** The Firefox build branch was removed; the listing on addons.mozilla.org is still the upstream release and does not contain these features.
- **Why the evening batch runs after 21:00.** YunBei task rewards and growth points need daytime progress, and the Music Sign punch can be silently dropped by the server (a success ack without an actual sign-in) — an evening re-check is what catches that. The verdict has three states, not two: "not counted" is only written when the ledger was actually exhausted (`hasMore` not true) or its entry timestamps bracket the target day; otherwise it says "cannot determine", which neither declares a failure nor fires the re-punch write. Note that the `sign/info` **record row** for a day comes from a separate, slower pipeline that can stay missing entirely — disproved as a verdict on 10-09 (the ledger entry and the monthly counter were both there 41 hours before any row appeared), so it is no longer read. These three actions therefore run only between 21:00–23:59, once a day; while any task still lacks a verdict the alarm is re-armed every 20 minutes inside that window, and only a fully settled batch rolls over to the next day. Missing one evening no longer means waiting 24 hours: the evening batch is attributed to *which evening* it belongs to (before 21:00 that means the one that just ended), so the two claim tasks run on the next wake-up instead, and the gate they write lands back on that evening — it cannot crowd out the normal 21:00 batch. The Music Sign re-check never joins a catch-up: after midnight that day can no longer be repaired, so a missed Music Sign evening is still a lost streak day.

Still GPL-3.0, same as upstream; all changes in this fork are open under GPL-3.0 as well.

## Key Features

- **Daily Check-in**: Completes both the web check-in and the YunBei (云贝) center check-in, and claims consecutive sign-in rewards once reached (3 / 7 / 28 days). Only two things count as "already signed today": a `code:200` from this run, or an explicit `sign:false` from YunBei (the documented "duplicate sign-in"). `-2` from `/api/point/dailyTask` is **no longer read as "already signed"** — that endpoint is undocumented in both reference protocol implementations, so it is treated as a rejection: no date gate, the server's `message` goes into the log verbatim, and the next trigger retries. A missing `sign` field means "no verdict this round", not "signed". And when `__csrf` cannot be read, **no write request is sent at all** — an answer to a token-less request was once read as "already signed", which gated the day and silently lost both check-ins.
- **Vinyl Music Sign (黑胶乐签)**: Completes the daily Music Sign punch through the same encrypted weapi call; works without a VIP entitlement. Whether a day actually counted is judged by that day's `黑胶乐签每日打卡` (+3) entry in the growth-point ledger (`level/growth/details`) — the ladder prize line `黑胶乐签阶梯奖励 +30`, which the server writes in the same second, is deliberately not accepted as a punch. The `sign/info` record row comes from a slower pipeline that can stay missing indefinitely — verified on 10-09, where the ledger entry and the monthly counter both existed 41 hours before any row appeared — so it is no longer used as the verdict. The evening batch re-punches once only when today's ledger entry is still missing and coverage is proven, reports "cannot determine" when the ledger was never exhausted, and reports "this machine never took part in that day" for days before the extension was running; the following morning reports the final verdict for the day that just ended.
- **YunBei Task Rewards**: Claims completed YunBei task rewards (e.g. Listen-to-Roaming) one by one between 21:00–23:59. Only finished tasks are claimed — the extension never performs the tasks themselves. A missed evening is picked up the next time the extension wakes.
- **VIP Growth Points**: Claims finished growth-task rewards once a day between 21:00–23:59 local time. Points never expire — a missed evening is picked up the next time the extension wakes, not the next 21:00.
- **Login Reminder**: If user has not logged in yet, will show a notification. Will switch to the opened webpage when user click it.
- **Scheduled Execution**: If the browser is not open or in sleep mode, it will execute the next time it is opened; while a task inside the evening window still has no verdict, the alarm is re-armed every 20 minutes.
- **Background Operation**: The check-in process is completed silently in the background, and will automatically close the page when it is finished.

## Installation

Chromium core browser users please open the link below to jump to the Chrome Web Store, click the blue button on the right "Add to XXX" (XXX is your browser, such as Chrome or Brave, etc.).

[Chrome Web Store](https://chromewebstore.google.com/detail/neteasemusicactivator/blmpkmpldchiiecilhgpahegoibafgci)

> The store listing is the upstream build: daily check-in only. The Music Sign / YunBei / growth-point features added in this fork need to be loaded manually — run `node build.js` and pick `dist/chrome` via "Load unpacked extension" in developer mode.

If you don't use Node, each release on this repository's [Releases](https://github.com/xiaoxu1642/NetEaseMusicActivator/releases) page attaches `NetEaseMusicActivator-v<version>.zip` (built `manifest.json` plus `LICENSE` included); unzip it and load that folder the same way.

Firefox users please open the link below to jump to the Firefox Add-ons Store, click the blue button on the right "Add to Firefox". This is the older upstream build as well.

[Firefox Add-ons Store](https://addons.mozilla.org/zh-CN/firefox/addon/neteasemusicactivator/)


## Usage

1. **Login**: First, **log in** to your account on the [NetEase Cloud Music official website (music.163.com)](http://music.163.com/).
2. **Auto Run**: The extension will automatically read your login status (Cookies) and perform the daily check-in task automatically in the background.
3. **Evening Batch Window**: The Music Sign re-check/re-sign, YunBei task rewards and the growth claim all run between 21:00 and 23:59 (the YunBei sign and the first Music Sign punch still happen on the extension's first run of the day). Keep the browser open during that window. As long as any task in that batch still has no verdict, the extension re-arms the alarm every 20 minutes inside the window instead of waiting for tomorrow. If the whole window is missed, the growth claim and YunBei rewards are **picked up the next time the extension wakes up** — no need to wait for the next 21:00. The Music Sign re-check never runs outside the window, so a missed Music Sign evening cannot be recovered.
4. **Status Toggle**: Click the logo to disable it when not needed, and the logo will automatically turn gray.

## Privacy Policy

1. No Data Collection: This extension does not collect, store, or transmit any personally identifiable information (PII), music listening history, or private user data to any external servers.

1. No Third-Party Endpoints: Every request goes to the three hosts the code actually calls — `music.163.com`, `interface.music.163.com`, `interface3.music.163.com` — and `host_permissions` is narrowed to exactly those. There is no analytics, advertising or update-check code.

1. Minimal Local State: `storage.local` holds exactly four keys — the on/off switch (`isEnabled`), a per-task "already done today" date (`taskDoneOn`), a claim ledger (`vipGrowthLog`) and a 7-day run log (`runtimeLogs`). The ledger stores the date and whether the claim succeeded; the run log holds each task's Chinese verdict line (e.g. "云贝任务：已领取 1/1 项") plus a few counters, with a per-entry byte cap and server-provided free text truncated. Cookies (`MUSIC_U`, `__csrf`), task names, song titles and listening history are never written to storage.

1. The permissions requested are used strictly for the core functionalities.

1. All code is open for use under the GPL-3.0.
