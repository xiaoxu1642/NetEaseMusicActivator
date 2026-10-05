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
| 黑胶乐签 | 走 `vip-center-bff/task/sign` 完成每日乐签打卡，无会员权益也可签到 |
| VIP 成长值一键领取 | 走 `vipnewcenter/app/level/task/reward/getall`，只在本地时间 21:00–23:59 触发、每天最多一次 |
| weapi 加密层 | 上述接口只接受 weapi 密文。`weapi.js` 用 WebCrypto（AES-128-CBC）+ BigInt 裸 RSA 实现，**零第三方依赖**，不引入 crypto-js / node-forge |
| 离线测试 | `node --test`：加密层与独立实现逐字节比对，调度门控用桩件验证 |

两点取舍需要说明：

- **只产出 Chromium / Edge 构建**。Firefox 的构建分支已移除，addons.mozilla.org 上仍是上游旧版，不含上述功能。
- **成长值为什么定在晚上领**。部分成长任务要靠白天的听歌进度累积，白天去领往往无值可领，所以该动作只在 21:00–23:59 触发。错过当晚不会损失任何成长值，它会在下一个窗口一并领走。

许可证沿用上游的 GPL-3.0，二改代码同样以 GPL-3.0 开源。

## 主要功能

- **每日签到**：自动完成网页端签到与云贝中心签到，并领取已达标的连续签到奖励（3 天 / 7 天 / 28 天）。
- **黑胶乐签**：自动完成「黑胶乐签」打卡，无会员权益也可签到。
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
3. **成长值领取时间**：成长值在 21:00–23:59 之间领取，因为部分任务要靠白天的听歌进度累积；这段时间内浏览器需要处于打开状态（当天错过不影响下次领取，成长值会累积）。
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

新增接口需要 weapi 加密时，统一走 `weapi.js` 的 `weapiRequest(host, path, data, csrfToken, query)`；已实现的端点与触发时机见 `background.js` 的 `TASKS` 表。二改的协议调研、接口清单与设计取舍记录在 `PLAN-signin-vip.md`。

---

## English

NetEase Cloud Music daily auto check-in, running silently in the background without disturbing your daily browsing experience. Suitable for overseas users in combination with [NetEaseMusicWorld++](https://github.com/kogamitora/NetEaseMusicWorldNext) (Chrome / Chromium) or [NetEaseMusicWorld+](https://github.com/nondanee/NetEaseMusicWorldPlus) (Firefox), the mobile and PC client will also be unlocked synchronously.

## About This Fork

This repository is a fork of [cmxin24/NetEaseMusicActivator](https://github.com/cmxin24/NetEaseMusicActivator). On top of the upstream daily check-in it adds:

| Addition | Details |
|---|---|
| YunBei center check-in + stage rewards | Besides the original `/api/point/dailyTask`, it also calls `pointmall/user/sign` and claims the consecutive sign-in rewards (3 / 7 / 28 days) once reached |
| Vinyl Music Sign | Daily Music Sign through `vip-center-bff/task/sign`; works without a VIP entitlement |
| VIP growth points | Claims everything pending through `vipnewcenter/app/level/task/reward/getall`, only between 21:00–23:59 local time, at most once per day |
| weapi crypto layer | Those endpoints only accept weapi payloads. `weapi.js` implements them with WebCrypto (AES-128-CBC) plus BigInt raw RSA — **no third-party dependencies**, no crypto-js / node-forge |
| Offline tests | `node --test`: byte-for-byte comparison of the crypto layer against an independent implementation, plus stubbed scheduling assertions |

Two deliberate trade-offs:

- **Chromium / Edge builds only.** The Firefox build branch was removed; the listing on addons.mozilla.org is still the upstream release and does not contain these features.
- **Why growth points are claimed in the evening.** Some growth tasks only progress while you listen during the day, so claiming earlier usually claims nothing. Missing one evening costs nothing — the points accumulate and are picked up in the next window.

Still GPL-3.0, same as upstream; all changes in this fork are open under GPL-3.0 as well.

## Key Features

- **Daily Check-in**: Completes both the web check-in and the YunBei (云贝) center check-in, and claims consecutive sign-in rewards once reached (3 / 7 / 28 days).
- **Vinyl Music Sign (黑胶乐签)**: Signs the daily Music Sign check-in automatically; works without a VIP entitlement.
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
3. **Growth Point Window**: Growth points are claimed between 21:00 and 23:59, because some tasks need daytime listening progress to accumulate. Keep the browser open during that window; missing one evening costs nothing.
4. **Status Toggle**: Click the logo to disable it when not needed, and the logo will automatically turn gray.

## Privacy Policy

1. No Data Collection: This extension does not collect, store, or transmit any personally identifiable information (PII), music listening history, or private user data to any external servers.

1. No Third-Party Endpoints: Every request goes to `music.163.com` or its subdomains only. There is no analytics, advertising or update-check code.

1. Minimal Local State: Only the on/off switch, a per-task "already done today" date and a claim ledger are kept in local storage. The ledger stores the date and whether the claim succeeded — never task names, song titles or listening history.

1. The permissions requested are used strictly for the core functionalities.

1. All code is open for use under the GPL-3.0.
