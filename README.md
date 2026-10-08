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
| 黑胶乐签 | 打卡走 `vip-center-bff/task/sign` 的 weapi 加密请求，无会员权益也可签到；21:00 后若服务端当天还没有签到记录行则补打一次，终态由次日晨批核对前一天的 `sign/info` 记录行给出 |
| 云贝任务奖励一键领取 | 走 `usertool/task/todo/query` + `usertool/task/point/receive`，在 21:00–23:59 与成长值同批领取已完成的任务奖励（如听漫游），只领已完成项、不代做任务 |
| VIP 成长值一键领取 | 走 `vipnewcenter/app/level/task/reward/getall`，只在本地时间 21:00–23:59 触发、每天最多一次 |
| weapi 加密层 | 上述接口只接受密文。`weapi.js` 用 WebCrypto（AES-128-CBC）+ BigInt 裸 RSA 自实现。**零第三方依赖**，不引入 crypto-js / node-forge |
| 离线测试 | `node --test`：加密层与独立实现逐字节比对，调度门控用桩件验证 |

两点取舍需要说明：

- **只产出 Chromium / Edge 构建**。Firefox 的构建分支已移除，addons.mozilla.org 上仍是上游旧版，不含上述功能。
- **为什么晚间批定在 21:00 之后**。云贝任务奖励与成长值都要等白天攒进度，白天去领往往无值可领。乐签则是因为**服务端记录行有数小时的滞后**：打卡回执 `data:true` 是有效的，但 `sign/info` 里那一天的记录和日历卡片要几个小时后才显示出来（`time` 仍回填成打卡那一刻），所以当天无法判定终态 —— 21:00 只在「今天还没有记录行」时补打一次（真丢了它是唯一修复机会，只是在排队时空转无害），确切的结论由次日晨批核对前一天给出。所以这三批动作都只在 21:00–23:59 触发，每天各一次。错过当晚：成长值与云贝任务奖励会在下一个窗口一并领走；乐签属签到类，漏一晚即断签一天。

许可证沿用上游的 GPL-3.0，二改代码同样以 GPL-3.0 开源。

## 主要功能

- **每日签到**：自动完成网页端签到与云贝中心签到，并领取已达标的连续签到奖励（3 天 / 7 天 / 28 天）。
- **黑胶乐签**：自动完成「黑胶乐签」打卡（`vip-center-bff/task/sign`），无会员权益也可签到；晚间 21:00 后若服务端当天还没有记录行则补打一次，终态由次日晨批核对前一天。
- **云贝任务奖励一键领取**：每天 21:00–23:59 把已完成的云贝任务奖励（如听漫游）逐个领取，只领已完成项，不代做任务本身。
- **VIP 成长值一键领取**：每天 21:00–23:59 之间领取已完成的成长任务奖励，每天只调用一次。成长值不过期，错过当晚会在下一个窗口一并领取。
- **登录提醒**：如果用户尚未登录，将发送一条通知进行提醒，点击跳转至后台已打开的网页。
- **定时执行**：如果浏览器未打开或处于休眠状态，将在下一次打开时执行。
- **后台运行**：签到过程在后台静默完成，完成后自动关闭网页。

## 安装方法

Chromium内核浏览器用户请点击下方链接跳转至Chrome Web Store, 点击右侧蓝色按钮「添加到XXX」即可（XXX为您的浏览器，如Chrome或者Brave等）。

[Chrome应用商店](https://chromewebstore.google.com/detail/neteasemusicactivator/blmpkmpldchiiecilhgpahegoibafgci)

> 商店里的是上游版本，只有每日签到。本 fork 新增的乐签 / 云贝 / 成长值需要自行 `node build.js` 后以「开启开发者模式 - 加载解压缩的扩展」方式安装。

Firefox用户请点击下方链接跳转至Firefox Add-ons Store, 点击右侧蓝色按钮「Add to Firefox」即可，此为旧版，有需要也可以提交issue交由我开发。

[Firefox Add-ons Store](https://addons.mozilla.org/zh-CN/firefox/addon/neteasemusicactivator/)

## 使用说明

1. **登录账号**：先在 [网易云音乐官网 (music.163.com)](https://music.163.com/) 中**登录**您的账号。
2. **自动运行**：扩展程序会自动读取您的登录状态（Cookies），并在后台自动进行每日的签到任务。
3. **晚间批时间**：乐签复核补打、云贝任务奖励领取、成长值领取都在 21:00–23:59 之间进行（云贝签到与乐签的首次打卡仍在每天首次运行扩展时完成）；这段时间内浏览器需要处于打开状态。成长值与云贝任务奖励错过当晚可在下一次窗口补领，乐签漏签一晚无法补。
4. **状态切换**：不需要时点击logo即可停用，logo将自动切换为灰色。

## 隐私说明

1. 不收集、不存储、也不传输用户的任何个人身份信息、听歌记录或隐私数据到任何外部服务器。

1. 所有网络请求仅发往 `music.163.com` 及其子域名，扩展不包含任何统计、广告或更新检查代码。

1. 本地仅保存开关状态、各任务的「今天是否已完成」日期与领取账目；领取账目只记日期与是否成功，不记录任务名称、歌曲或听歌历史。

1. 申请的权限仅用于实现核心功能.

1. 所有代码依照GPL-3.0开源。

## 开发

```bash
node build.js        # 生成 dist/chrome；在 edge://extensions 打开开发者模式，「加载解压缩的扩展」选它
node --test          # 离线测试：weapi 加密层等价比对 + 调度门控行为，不联网
```

新增接口需要加密时：weapi 统一走 `weapi.js` 的 `weapiRequest(host, path, data, csrfToken, query)`。本仓库只做 weapi，不实现 eapi（它要额外伪造一批设备身份 cookie）。已实现的端点与触发时机见 `background.js` 的 `TASKS` 表。二改的协议调研、接口清单与设计取舍记录在 `PLAN-signin-vip.md` 与 `PLAN-evening-batch.md`。

---

## English

NetEase Cloud Music daily auto check-in, running silently in the background without disturbing your daily browsing experience. Suitable for overseas users in combination with [NetEaseMusicWorld++](https://github.com/kogamitora/NetEaseMusicWorldNext) (Chrome / Chromium) or [NetEaseMusicWorld+](https://github.com/nondanee/NetEaseMusicWorldPlus) (Firefox), the mobile and PC client will also be unlocked synchronously.

## About This Fork

This repository is a fork of [cmxin24/NetEaseMusicActivator](https://github.com/cmxin24/NetEaseMusicActivator). On top of the upstream daily check-in it adds:

| Addition | Details |
|---|---|
| YunBei center check-in + stage rewards | Besides the original `/api/point/dailyTask`, it also calls `pointmall/user/sign` and claims the consecutive sign-in rewards (3 / 7 / 28 days) once reached |
| Vinyl Music Sign | Punches in through the encrypted `vip-center-bff/task/sign` weapi call; works without a VIP entitlement. The server writes the sign record hours later, so after 21:00 it re-punches once only when today's record row is still missing, and the next morning's batch verifies the previous day against `sign/info` |
| YunBei task rewards | Claims completed YunBei task rewards (e.g. Listen-to-Roaming) through `usertool/task/todo/query` + `usertool/task/point/receive`, one by one, in the 21:00–23:59 batch; only claims finished tasks, never performs them |
| VIP growth points | Claims everything pending through `vipnewcenter/app/level/task/reward/getall`, only between 21:00–23:59 local time, at most once per day |
| weapi crypto layer | Those endpoints only accept encrypted payloads. `weapi.js` uses WebCrypto (AES-128-CBC) plus BigInt raw RSA, implemented in-house. **No third-party dependencies**, no crypto-js / node-forge |
| Offline tests | `node --test`: byte-for-byte comparison of the crypto layer against an independent implementation, plus stubbed scheduling assertions |

Two deliberate trade-offs:

- **Chromium / Edge builds only.** The Firefox build branch was removed; the listing on addons.mozilla.org is still the upstream release and does not contain these features.
- **Why the evening batch runs after 21:00.** YunBei task rewards and growth points need daytime progress, and the Music Sign punch can be silently dropped by the server (a success ack without an actual sign-in) — an evening re-check is what catches that. So the Music Sign re-check/re-sign, the YunBei task rewards and the growth claim all run only between 21:00–23:59, once a day. Missing one evening: growth points and YunBei rewards are picked up in the next window; a missed Music Sign evening is a lost streak day.

Still GPL-3.0, same as upstream; all changes in this fork are open under GPL-3.0 as well.

## Key Features

- **Daily Check-in**: Completes both the web check-in and the YunBei (云贝) center check-in, and claims consecutive sign-in rewards once reached (3 / 7 / 28 days).
- **Vinyl Music Sign (黑胶乐签)**: Completes the daily Music Sign punch through the same encrypted weapi call; works without a VIP entitlement. Because the record row appears on the server hours after the punch, the evening batch re-punches once only when today's row is still missing, and the following morning reports the final verdict for the day that just ended.
- **YunBei Task Rewards**: Claims completed YunBei task rewards (e.g. Listen-to-Roaming) one by one between 21:00–23:59. Only finished tasks are claimed — the extension never performs the tasks themselves.
- **VIP Growth Points**: Claims finished growth-task rewards once a day between 21:00–23:59 local time. Points never expire — a missed evening is picked up in the next window.
- **Login Reminder**: If user has not logged in yet, will show a notification. Will switch to the opened webpage when user click it.
- **Scheduled Execution**: If the browser is not open or in sleep mode, it will execute the next time it is opened.
- **Background Operation**: The check-in process is completed silently in the background, and will automatically close the page when it is finished.

## Installation

Chromium core browser users please open the link below to jump to the Chrome Web Store, click the blue button on the right "Add to XXX" (XXX is your browser, such as Chrome or Brave, etc.).

[Chrome Web Store](https://chromewebstore.google.com/detail/neteasemusicactivator/blmpkmpldchiiecilhgpahegoibafgci)

Firefox users please open the link below to jump to the Firefox Add-ons Store, click the blue button on the right "Add to Firefox".

[Firefox Add-ons Store](https://addons.mozilla.org/zh-CN/firefox/addon/neteasemusicactivator/)


## Usage

1. **Login**: First, **log in** to your account on the [NetEase Cloud Music official website (music.163.com)](http://music.163.com/).
2. **Auto Run**: The extension will automatically read your login status (Cookies) and perform the daily check-in task automatically in the background.
3. **Evening Batch Window**: The Music Sign re-check/re-sign, YunBei task rewards and the growth claim all run between 21:00 and 23:59 (the YunBei sign and the first Music Sign punch still happen on the extension's first run of the day). Keep the browser open during that window. Growth points and YunBei rewards missed one evening are picked up in the next window; a missed Music Sign evening cannot be recovered.
4. **Status Toggle**: Click the logo to disable it when not needed, and the logo will automatically turn gray.

## Privacy Policy

1. No Data Collection: This extension does not collect, store, or transmit any personally identifiable information (PII), music listening history, or private user data to any external servers.

1. No Third-Party Endpoints: Every request goes to `music.163.com` or its subdomains only. There is no analytics, advertising or update-check code.

1. Minimal Local State: Only the on/off switch, a per-task "already done today" date and a claim ledger are kept in local storage. The ledger stores the date and whether the claim succeeded — never task names, song titles or listening history.

1. The permissions requested are used strictly for the core functionalities.

1. All code is open for use under the GPL-3.0.
