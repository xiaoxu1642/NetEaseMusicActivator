# 二改方案：每日签到 + 乐签签到 +（可选）VIP 成长任务一键领取

> 状态：**P0–P2 已实现并通过离线测试（17/17）**。图一（云贝签到 + 连签阶段奖励 + 黑胶乐签）与图二（VIP 成长值 21:00 窗口领取）已落地；P3 popup 未做。实现与本方案的两处偏差记在 §5.5。
> 目标仓库：本仓库（fork 自 `cmxin24/NetEaseMusicActivator`，GPL-3.0）
> 协议参考：`netease-cloud-music-master`（Go，`ncmctl`）、`NeteaseMusic-API-main`（Node，NeteaseCloudMusicApi 风格）—— 两个同级只读参考仓库，不在本仓库内

---

## 0. 结论摘要

| 诉求 | 可行性 | 说明 |
|---|---|---|
| 图一 · 每日签到 | ✅ 已存在，需补强 | `background.js:151-186` 已在做 `/api/point/dailyTask?type=1`（经验/积分签到）。图一红框左侧其实是**云贝中心签到 + 连签阶段奖励（3天/7天/28天）**，这是另一条接口链，目前完全没做。 |
| 图一 · 乐签签到（黑胶乐签） | ✅ 可做 | `weapi/vip-center-bff/task/sign` 打卡；⚠️ 返回 `data===true` **只代表请求被受理，不等于已落签**（实测过只翻任务态、不生成记录的情形），终态须回读 `minidesk/music/sign/pc` 卡片的 `sign`。日历/成长值用 `vipnewcenter/app/user/sign/info` 与 `minidesk/music/sign/pc` 读取。 |
| 图二 · VIP 成长任务「一键领取 +81」 | ✅ 可做 | 官方就有 `weapi/vipnewcenter/app/level/task/reward/getall`，一次调用等价于点那个按钮。**按 2026-10-05 决定：仅在本地时间 21:00–23:59 窗口触发、每天最多调用一次、成功即落本地账目**（理由：部分成长任务靠白天听歌累积进度，领早了没东西可领）。详见 §5.4。 |
| 图二 · 自动**完成**成长任务（设置开机启动图 / 红心 3 首 VIP 单曲） | ⚠️ 部分可做，**默认不做** | 「红心」可用 `/weapi/playlist/manipulate/tracks` 做到，但它会改写用户「我喜欢的音乐」列表；「设置开机启动图」是 PC 客户端本地设置，无 Web 接口 → **不可自动化**。详见 §3.1。 |

**唯一的基础设施成本**：扩展目前只会发免加密的 `/api/` 明文请求，而上述新接口全部只走 **weapi** 加密通道。因此需要先实现一份零依赖的 weapi 加密层（WebCrypto AES-CBC + BigInt 裸 RSA，约 70 行，见 §5.2）。

**权限与隐私零变化**：新接口的 host（`interface.music.163.com` / `interface3.music.163.com`）已被 `manifest.base.json:25-28` 现有的 `*://*.music.163.com/*` 通配覆盖，**不需要新增 `host_permissions`**，出网域名仍然只有 music.163.com 一家。

---

## 1. 现状盘点（已核对源码）

目标项目**不是 C# 桌面程序**，而是一个 **Manifest V3 浏览器扩展（原生 JS，零第三方依赖）**，共 7 个源文件。

| 关注点 | 现状 | 位置 |
|---|---|---|
| 运行体 | service worker，无 popup / options 页面 | `manifest.base.json:9-18`、`build.js:9-12` |
| 登录态 | 不持有凭据，直接读浏览器里 music.163.com 的 `MUSIC_U` cookie | `background.js:242` |
| CSRF | 读 `__csrf` cookie 塞进表单 | `background.js:153-159` |
| 请求方式 | 裸 `fetch` + `credentials:'include'`，无 ApiClient 抽象 | `background.js:161-166` |
| 加密 | **完全没有** eapi/weapi 实现 | 全仓无 encrypt/AES/RSA/md5 |
| 已实现接口 | 仅 1 条：`POST https://music.163.com/api/point/dailyTask?type=1` | `background.js:155` |
| 结果判定 | `200` 成功 / `-2` 今日已签 / 其它=未登录 | `background.js:169-178` |
| 定时 | 单个 `chrome.alarms`，次日 `00:00:05` 触发 | `background.js:140-146`、`275-277` |
| 幂等门 | **一个**全局 `lastOpenedDate` 字符串 | `background.js:231`、`240-241` |
| UI | 只有红/灰图标两态；点图标切换 `isEnabled` | `background.js:113-135`、`265-273` |
| 日志 | 自研持久化日志（7 天 / 2000 条），`logInfo/logWarn/logError` | `background.js:5-110` |
| 构建 | `node build.js` 生成 `dist/chrome` + `dist/firefox`，资产白名单需手工维护 | `build.js:37` |
| 测试 / CI | **无**（无 package.json、无 .github） | — |
| 隐私声明 | 三条承诺（不收集、权限仅核心功能、GPL-3.0） | `README.md:34-40` |

两个必须提前知道的坑：

1. **`lastOpenedDate` 是单一日期门**（`background.js:241`）。多任务复用它会互相吞掉：A 成功、B 失败，明天整批仍被跳过。必须改成**按任务分键**的日期状态（§5.4）。
2. **`chrome.action.onClicked` 在设置了 `action.default_popup` 后不再触发**（Chrome 行为）。一旦加 popup，现有"点图标开关"逻辑必须迁移到 popup 内部，否则功能直接失效（§5.6）。

---

## 2. 图一拆解 → 接口映射

图一红框是**两张独立卡片**，对应两条互不相干的接口链：

### 2.1 左卡「每日签到 / 再连签 N 天可领奖 / 前往云贝中心」

这是**云贝中心连签**，不是现有的 `point/dailyTask`。

| 步骤 | weapi 路径 | Host | 请求体 | 成功/状态判定 | 协议来源 |
|---|---|---|---|---|---|
| ① 执行今日签到 | `/weapi/pointmall/user/sign` | `music.163.com` | `{}` | `code===200`；`data.sign===true` 本次签到成功，`false` 今天已签过 | Go `api/weapi/yunbei.go:299-313`、`285-294` |
| ② 读连签阶段奖励 | `/weapi/pointmall/user/sign/config` | `music.163.com` | `{}` | `data.lotteryConfig[]`，每项含 `signDay`(3/7/28)、`baseGrant.name`(奖励文案)、`baseLotteryId`、`baseLotteryStatus` | Go `yunbei.go:756-770`、结构体 `715-743` |
| ③ 领取到期的阶段奖励 | `/weapi/pointmall/user/sign/lottery/get` | `interface.music.163.com` | `{"userLotteryId":"<baseLotteryId>"}` | `data===true` 领取成功；`false` 已领过 | Go `yunbei.go:909-923`，注释 L900 明确 `userLotteryId` 就是 `baseLotteryId` |
| ④（可选）连签日历 | `/weapi/pointmall/sign/calendar` | `music.163.com` | `{}` | `data.signStr` 是 30 位 0/1 串，`1`=当天已签 | Go `yunbei.go:668-682`、`658-663` |
| ⑤（可选）今日所得云贝 | `/weapi/point/today/get` | `music.163.com` | `{}` | `data.shells` | Go `yunbei.go:328-342` |
| ⑥（可选）累计签到天数 | `/weapi/point/signed/get` | `music.163.com` | `{}` | `data.days` / `data.shells` | Go `yunbei.go:218`；Node `module/yunbei.js:5` |

领取条件判读（Go 侧注释 `yunbei.go:737-740`）：`baseLotteryId > 0 && baseLotteryStatus === 0` → 有奖励待领；`baseLotteryStatus === 1` → 已领。满勤抽奖走 `extraLotteryId`，Go 项目自己标了 `Pending`（`internal/ncmctl/sign.go:146`），**本期不做**。

> 现有 `point/dailyTask` 保留不动。它和 `pointmall/user/sign` 是两套奖励（经验 vs 云贝），官方客户端两个都会各自记录，串行执行互不冲突。Go 项目同样两条都实现（`yunbei.go:39` weapi 版 + `api/eapi/yunbei.go:14-48` eapi 版）。

### 2.2 右卡「黑胶乐签 / 再打卡 6 天有惊喜 / 2日 3日 4日 今天」

| 步骤 | weapi 路径 | Host | 请求体 | 判定 | 协议来源 |
|---|---|---|---|---|---|
| ① 打卡 | `/weapi/vip-center-bff/task/sign` | `interface3.music.163.com` | `{}`（Go 侧 URL 尾部带空值 `?isNew=`） | `code===200 && data===true` 只表示**请求被受理**；`data===false` 时读 `message` 文案。⚠️ **是否落签不得据此判定**：`data:true` 仅翻转任务态（`vip-center-bff/task/list` 的乐签条目变 `status:100`、今日成长值 +3），终态看 ③ 卡片或 ② 的 `recordId>0`。且任务态一旦置为已打卡，当天再打只是空转 —— 详见 `PLAN-evening-batch.md` 补充节 | Go `api/weapi/vip.go:1311`；eapi 等价 `api/eapi/vip.go:68-97`（**该形态实测只翻任务态、不生成记录，已弃用**）；Node `module/vip_sign.js:4-11` |
| ② 打卡信息 | `/weapi/vipnewcenter/app/user/sign/info` | `interface3.music.163.com` | `{}` | ~~`data[].today===true` 表示今天已签~~；`score` 为成长值。⚠️ **更正（2026-10-06）：`today` 只是"当日格子"标记，非已签判定；已签看 minidesk 卡片 `signInfoList[].sign`，详见 `PLAN-evening-batch.md` 补充节** | Go `vip.go:593`、`585`；Node `module/vip_sign_info.js:7` |
| ③ 日历卡片（展示用） | `/weapi/vipnewcenter/app/minidesk/music/sign/pc` | `interface3.music.163.com` | `{"type":"0"}` 或 `{"type":"1"}` | `data.text/subText/btnText`、`data.signInfoList[]{dayText,sign,today,signTime,songCoverUrl}` | Go `vip.go:1503`；eapi 版 `api/eapi/vip.go:383-444` |
| ④ 当月累计/节点奖 | `/weapi/vipnewcenter/app/level/user/checkin/history/detail` | `interface3.music.163.com` | `{"type":"1","signDayTime":"<Date.now()>"}` | `monthCheckInTotalDay`、`monthCheckInPrizList[].day`（7/14/28 节点）；**服务端字段拼写就是 `prizList`** | Go `vip.go:1434`；eapi 版 `api/eapi/vip.go:286-381` |

关键事实（来自 Go 的编排代码 `internal/ncmctl/sign.go:169-195`）：**乐签打卡不要求黑胶 VIP 权益** —— Go 注释原文 "VIP entitlement gates growth rewards only; Music Sign is available without it."。所以非会员也能打卡，只是拿不到成长值。

`type` / `signDayTime` 在 Go 侧以**字符串**下发（`api/vip_sign_test.go:245-256` 的 wire 级断言），实现时照抄，不要用 number。

---

## 3. 图二可行性：VIP 成长任务「一键领取 +81」

**结论：可以做，而且是最省事的一条。** 官方就提供了聚合领取接口，一次调用等价于点那个红色按钮。

| 用途 | weapi 路径 | Host | 请求体 | 判定 | 来源 |
|---|---|---|---|---|---|
| **一键领取全部成长值** | `/weapi/vipnewcenter/app/level/task/reward/getall` | `music.163.com` | `{}` | `code===200 && data.result===true`；`false` 时读 `message` | Go `api/weapi/vip.go:70`、`55-82` |
| 按任务领取（备选） | `/weapi/vipnewcenter/app/level/task/reward/get` | `music.163.com` | `{"taskIds":"8613118351_1,8607552957_1"}` | `code===200` | Go `vip.go:39`、`17-53`（空 taskIds 直接报错）；Node `module/vip_growthpoint_get.js:5-12` |
| 任务列表（读待领） | `/weapi/vipnewcenter/app/level/task/list` | `music.163.com` | `{}` | `data.taskList[].taskItems[]` 中 `needReceive===true` 的项，`unGetIds[]` 即待领 id，`totalUngetScore` 即"+81"那个数字 | Go `vip.go:136`、结构体 `90-129` |
| 前置门禁：成长值现状 | `/weapi/vipnewcenter/app/level/growhpoint/basic` | `music.163.com` | `{}` | `data.userLevel.latestVipStatus===1` 才有 VIP 权益；`maxLevel===true` 满级则跳过 | Go `vip.go:444`；编排 `internal/ncmctl/sign.go:160-178` |
| 本月上限 | `/weapi/vipnewcenter/app/user/max/score` | `interface3.music.163.com` | `{}` | `reachMonthMaxScore===true` 跳过；`maxTaskScore` 黑胶 300 / SVIP 400 | Go `vip.go:627`、`615-620` |

注意路径里 `growhpoint` 是**服务端原始拼写错误**（不是笔误），照抄。

上表只有 `reward/getall` 是"动作"，其余三条都是"读"。按 2026-10-05 的窗口约束，**happy path 整晚只发 `getall` 一个请求**，VIP 门禁读接口降级为"返回非 200 时才补发一次"的诊断分支 —— 详见 §5.4 末段。

### 3.1 「领取」和「完成」是两件事

图二那张卡片上有两类按钮，必须分开回答：

- **「一键领取 +81」= 领已完成任务攒下的成长值** → 上面 `reward/getall` 一条搞定，**可实现，低风险**。
- **「去完成」= 真的去做那个任务** → 逐条看：

| 任务 | 能否自动化 | 手段 / 原因 |
|---|---|---|
| 设置开机启动图 | ❌ **不可** | PC 客户端本地设置项，Web 侧无对应接口。两个参考仓库里都没有任何相关端点（已确认未找到）。 |
| 红心 3 首 VIP 单曲 | ⚠️ 技术上可 | 走 `/weapi/playlist/manipulate/tracks`（`op:'add'`, `pid:'like'`）即可红心。**但它会真实改写用户的「我喜欢的音乐」列表** —— 属于修改用户数据，必须显式开关 + 默认关闭，不能静默做。 |
| 浏览 VIP 页面 N 秒 | ⚠️ 技术上可，**不建议** | `interface.music.163.com/weapi/middle/page/view/report`（Go `vip.go:1579`，需要伪造 `netease_webkit_context` 头 + 特定 UA/Origin）。这是纯模拟行为。 |
| 试听歌曲打卡 | ⚠️ 同上 | `eapi/vipmall/interest/trialsong/listen`（Go `api/eapi/vip.go:566-595`），需要 eapi（要 MD5 + AES-ECB），成本更高。 |

**建议边界**：本期只实现「一键领取」，把「自动完成任务」排除在范围外。理由：Go 参考项目自己把这类聚合领取放在 `--automatic` 开关后面，并在帮助文本里明写 "may increase risk-control exposure"（`internal/ncmctl/sign.go:40-45`）—— 连参考实现都把它当高风险动作对待，一个跑在用户日常浏览器里、带真实登录 cookie 的扩展更没有理由默认开启。

---

## 4. 隐私 / 合规自检（对齐仓库三条承诺）

| 承诺 | 本方案是否满足 | 依据 |
|---|---|---|
| 不收集、不存储、不传输任何 PII / 听歌记录到外部服务器 | ✅ | 所有新增端点 host 均为 `*.music.163.com`；`host_permissions` 不扩张（`manifest.base.json:25-28` 的通配已覆盖 `interface`/`interface3`）；不引入任何第三方 CDN / 遥测 / 更新检查；不新增 `tabs`、`scripting`、`declarativeNetRequest` 权限。 |
| 申请的权限仅用于实现核心功能 | ✅ 无新增权限 | 复用现有 `storage`/`alarms`/`cookies`/`notifications`。 |
| GPL-3.0 开源 | ✅ | 新增代码随仓库继续 GPL-3.0；weapi 算法按 `NeteaseMusic-API-main/util/crypto.js:56-71` 与 `pkg/crypto/crypto.go:324-353` 的公开协议实现重写，**不 vendor 任何第三方源码**（不引 crypto-js / node-forge）。 |
| 日志不落敏感值 | ✅ 延续现有做法 | 现有 `logInfo` 的 `details` 只记 `code`/`point`（`background.js:170-176`）。新代码同样**只记状态码与业务字段，绝不记 cookie、`__csrf`、`params`/`encSecKey` 密文、歌曲名**。 |
| 凭据处理 | ✅ | 不新增任何凭据落盘；`csrf_token` 只在单次请求内存里使用。 |

**需要一并更新的文档**（落地阶段做，本方案不动）：`README.md:11-16` / `:48-53` 功能列表、`README.md:34-40` 隐私说明里补一句"新增接口仍限定在 music.163.com 域内"、`manifest.base.json:4` 版本号 `1.0.0 → 1.1.0`。商店版本重新提交会再过一次人工审核。

---

## 5. 技术方案

### 5.1 加密通道选型：只做 weapi，不做 eapi

| 维度 | weapi | eapi |
|---|---|---|
| 需要 MD5 | ❌ 不需要 | ✅ 需要（`nobody{url}use{data}md5forencrypt`），**WebCrypto 不支持 MD5**，得手写 ~50 行 |
| 需要 AES-ECB | ❌ 只需 AES-128-**CBC**，WebCrypto 原生 | ✅ 需要，WebCrypto 不直接支持，得用 CBC+零 IV 拼 |
| 需要 RSA | ✅ 裸 RSA（no padding） | ❌ |
| 响应是否加密 | ❌ 明文 JSON | ✅ `e_r=true` 时密文 + gzip（要 `DecompressionStream`） |
| 目标接口覆盖 | **本方案全部 4 条链都有 weapi 版**（已逐条 grep 确认） | 部分只有 eapi |
| 与浏览器流量贴合度 | 高（官方 Web 播放器就走 weapi） | 低（是 Android 客户端流量，要伪造 appver/channel/mobilename 等一堆 cookie） |

**决策：只实现 weapi。** 唯一要手写的是裸 RSA（WebCrypto 不支持 no-padding），用 BigInt 模幂 8 行搞定，比手写 MD5 便宜得多。

### 5.2 weapi 加密层（可直接落地的骨架，约 70 行）

算法（两份参考实现完全一致）：
```
secretKey = 16 位 base62 随机串
params    = AES-128-CBC( base64( AES-128-CBC( json, presetKey, iv ) ), secretKey, iv )   // 两层，均 PKCS#7，输出 base64
encSecKey = hex( (reversed(secretKey) as bigint) ^ 65537 mod N )                          // 无填充，左补 0 到 256 个 hex 字符
```
常量：`iv = "0102030405060708"`，`presetKey = "0CoJUm6Qyw8W8jud"`
来源：`NeteaseMusic-API-main/util/crypto.js:56-71`（`crypto.js:4-7` 常量）；`netease-cloud-music-master/pkg/crypto/crypto.go:324-353` + `RsaEncrypt` `244-265`（`FillBytes(pubKey.Size())` = 左补零到 128 字节 = 256 hex）

RSA 模数（已从公钥 PEM 解析出的现成常量，**实现时直接写死，省掉 PEM 解析**）：

```js
// n (1024-bit, 128 字节) / e = 65537
const RSA_N = 0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b72515
  2b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870
  114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef5274
  1d546b8e289dc6935b3ece0462db0a22b8e7n;
const RSA_E = 65537n;
```

骨架代码（**本文件仅为设计稿，未写入 `background.js`**）：

```js
const AES_IV = new TextEncoder().encode('0102030405060708');
const AES_PRESET = new TextEncoder().encode('0CoJUm6Qyw8W8jud');
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function aesCbcB64(keyBytes, plainText) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: AES_IV }, key, new TextEncoder().encode(plainText));
  return b64(ct);                       // WebCrypto 自带 PKCS#7 填充
}

function randomSecretKey() {            // 拒绝采样，避免 %62 的模偏置
  const out = [], buf = new Uint8Array(64);
  while (out.length < 16) {
    crypto.getRandomValues(buf);
    for (const x of buf) { if (x < 248) out.push(BASE62[x % 62]); if (out.length === 16) break; }
  }
  return out.join('');
}

function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }

function rsaNoPad(text) {               // 16 字节 ASCII → 256 位 hex，左补 0
  let v = 0n;
  for (const ch of text) v = (v << 8n) | BigInt(ch.charCodeAt(0));
  return modPow(v, RSA_E, RSA_N).toString(16).padStart(256, '0');
}

async function weapiEncrypt(payload, fixedKey) {   // fixedKey 仅离线等价测试注入用
  const sk = fixedKey || randomSecretKey();
  const inner = await aesCbcB64(AES_PRESET, JSON.stringify(payload));
  return { params: await aesCbcB64(new TextEncoder().encode(sk), inner), encSecKey: rsaNoPad([...sk].reverse().join('')) };
}
```

> `secretKey` 首字符是 base62（最大 `'z'`=0x7a），16 字节拼出的整数恒小于 `N`（首字节 0xe0），无需额外取模保护。

### 5.3 统一请求层

```js
async function weapiPost(path, data = {}, host = 'music.163.com') {
  const csrf = await getCookie('MUSIC_U' /* 存在性检查 */, '__csrf');
  const { params, encSecKey } = await weapiEncrypt({ ...data, csrf_token: csrf });
  const res = await fetch(`https://${host}${path}?csrf_token=${encodeURIComponent(csrf)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    credentials: 'include',
    body: new URLSearchParams({ params, encSecKey }),
  });
  return res.json();                    // weapi 响应是明文 JSON，无需解密
}
```

设计要点：

- **`csrf_token` 同时放密文体内和 query**。Go 客户端放 query（`api/api.go:525-532`），Node 客户端放 body（`util/request.js:200-206`），两份参考实现都能跑通，说明服务端两种都收。扩展按"两处都给"写一次，省掉一次试错往返。
- **`Referer` / `User-Agent` 不改**。fetch 里它们是 forbidden header，设了会被静默忽略。不为此加 `declarativeNetRequest` 权限：Go 客户端用 Android okhttp UA、Node 用 Edge UA 都能成功，证明 weapi 不强校验这两个头。列为低风险未验项（§8）。
- **错误分类**（新代码统一走这个出口，不要各处 `if/else`）：
  - `code === 301` / `data === null` → **未登录**，中止整批，走现有 `showLoginNotification()`（`background.js:217-225`）
  - HTTP 非 2xx / JSON 解析失败 / `fetch` reject → **瞬态失败**，本次不写日期状态，明天重试
  - `code === -2` / `data.sign === false` / `data.result === false` → **已完成**，写日期状态，不报错
  - 其它 `code` → **业务失败**，`logWarn` 记 `code` + `message`，写日期状态（避免每天重试同一个不支持的接口）
- 现有 `performCheckIn()`（`background.js:151-186`）保持明文 `/api/` 不动 —— 它是唯一已验证可用的路径，没必要为了统一去改它。

### 5.4 调度与幂等：两批 + 一个晚间窗口

三个功能分两批跑，因为**它们的最佳触发时刻不同**：签到类要尽早（当天第一次开浏览器就签上），成长值领取要尽量晚（"听歌 N 分钟"这类任务要等白天累积完进度，才有东西可领）。

```js
const TASKS = [
  { key: 'dailyTask',   batch: 'morning', run: signDailyTask },      // 现有，明文 /api/
  { key: 'yunbeiSign',  batch: 'morning', run: signYunbei },          // pointmall/user/sign
  { key: 'yunbeiStage', batch: 'morning', run: claimYunbeiStages },   // sign/config → lottery/get
  { key: 'vipSign',     batch: 'morning', run: signVipMusic },        // vip-center-bff/task/sign
  { key: 'vipGrowth',   batch: 'night', window: 21, run: claimVipGrowth },  // ← 硬性 21:00–23:59
];
```

**两个 alarm**（现有代码只有一个 alarm 和一个全局日期门，`background.js:3`、`140-146`、`240-241`；引入第二个时间窗后必须再加一个）：

| alarm | 触发时刻 | 跑什么 | 落点 |
|---|---|---|---|
| `ALARM_NAME`（复用 `background.js:3`） | 次日 `00:00:05` | morning 批 | 改 `background.js:140-146`，另加 `scheduleNightRun()` 排到**当天/次日 21:00:00** |
| `ALARM_VIP_CLAIM`（新增） | 当天 `21:00:00` | night 批 | `chrome.alarms.onAlarm` 按 `a.name` 分派（改 `background.js:275-277`），每次触发后重新排到明天 21:00 |

**两条触发路径都要装**，它们覆盖互补的日常：`onStartup` / `onInstalled`（`background.js:295-296`）覆盖"晚上才开浏览器"，即你说的"浏览器于 21:00–23:59 启动时触发"；`ALARM_VIP_CLAIM` 在 21:00:00 定点触发覆盖"浏览器从白天一直开着没关"—— 少了这条，挂机党反而永远领不到，所以它不是可选项。两条共用同一个 `shouldRunNight()` 门，谁先到谁执行、另一个被日期门挡住：

```js
function shouldRunNight(now, state) {
  if (now.getHours() < 21) return false;              // 硬性窗口下界；23:59 后自然属于次日
  if (state.taskDoneOn.vipGrowth === localDate(now)) return false;   // 当天只调用一次
  return true;
}
```

窗口规则逐条明确：

1. **只在本地时间 21:00:00–23:59:59 内发起**（`Date#getHours()` 用本地时区，符合"我这边的晚上"；不做 UTC 换算）。
2. **每天最多调用一次**。已领过（`taskDoneOn.vipGrowth === 今天`）直接跳过；21:30、22:10、23:00 反复重启浏览器只会在第一个落点执行一次。
3. **单次触发内不循环重试**。失败（网络错 / 未登录 / 非预期 `code`）不写日期状态，等当天窗口内下一次浏览器启动再给一次机会；浏览器从 21:00 一直开着不重启，则当天就此一次，明天再来。
4. **整天没在窗口内开过浏览器 → 当天跳过，不补跑**。成长值不丢，累积到下次窗口一起领 —— 这是"晚间领取"能安全跳过而无需补偿机制的原因。
5. 已知良性边界：23:59:xx 触发、请求跨过本地零点，会让次日日期门误判为"没领过"从而再发一次 `getall`。`reward/getall` 无可领取时返回 `data.result === false`（Go `api/weapi/vip.go:57-63`、`internal/ncmctl/sign.go:269-275`），**不会重复发放**，所以不加 6 小时冷却之类的额外机制。
6. **并发触发必须加单飞锁（真机暴露的缺陷，非推测）**。2026-10-05 22:56 首次真机运行时，`onStartup` / `onInstalled` 与一条迟到的 21:00 alarm 在同一个 service worker 实例里并发触发 `checkAndRun()`，两边都在对方写日期门之前读到了旧状态，结果同一秒内 `getall` 被打了两次、`vipGrowthLog` 写出两条当日记录 —— 直接违反"每天只调用一次"。修复：`checkAndRun` 外面套 in-flight 锁，并用 `rerunRequested` 在锁释放后补跑一轮（补跑会被日期门全部挡住，零请求，但保证迟到的触发不被吞掉）。离线用例「并发触发…每个接口只打一次」是这条的回归护栏 —— 把锁旁路掉后，5 个端点各被打 3 次。

**"只调用一次"与 VIP 门禁的取舍**：Go 参考实现在领取前要先读 `growhpoint/basic` + `user/max/score` 判断会员权益/满级/本月上限（`internal/ncmctl/sign.go:160-178`），那是 3 次请求。按你的约束改成 —— **happy path 只发 `reward/getall` 一次**；仅当它返回非 `200` 时，才补发一次 `growhpoint/basic` 作为**诊断分支**（只为把"非会员 / 已满级 / 已达 300·400 上限"写进日志解释清楚），正常日子里整晚就一个请求。

**morning 批的门控**：

- 新增 storage key `taskDoneOn = { [taskKey]: 'YYYY-MM-DD' }`，替换现在单一的全局 `lastOpenedDate`（`background.js:231`、`240-241`）—— 否则 A 成功、B 失败时，B 明天仍会被 A 的日期门吞掉。
- 只有归类为**成功 / 已完成 / 明确不支持**才写日期状态；瞬态失败不写，下次启动自然重试。
- 整批入口仍由现有 `isEnabled`（`background.js:231`）驱动；某批全部任务都已 `doneOn` 时直接返回，零网络请求。
- 未登录（`code === 301`）中止时**不写任何 `taskDoneOn`**，保持现有"登录通知 + 后台开标签页"行为（`background.js:248-253`）。
- `executeSuccessTask()` 开后台标签页保留但整批只开一次（现绑在成功分支，`background.js:191-208`），顺带刷新网页会话 cookie。

**领取结果落本地日志**（你的要求，需要新增，不能只靠 `runtimeLogs`）：现有持久化日志按 7 天 / 2000 条滚动裁剪（`background.js:6-7`、`34-39`），不足以回看一个月的领取账。新增一条**独立的结构化账目**：

```js
// chrome.storage.local
vipGrowthLog: [ { d: 'Mon Oct 05 2026', ok: true, ts: 1759622400000 } ]   // 上限 60 条，超出丢最旧
```

只记**日期与是否成功**，不记任务名、不记歌曲名/歌手名 —— 与"不存储听歌记录"的承诺严格对齐（成长任务里含"听歌"类条目，把任务名写进持久化存储就越界了）。

金额拿不到是协议决定的：`reward/getall` 的响应只有 `data.result` 布尔值（Go `api/weapi/vip.go:57-63`）。想在账目里显示「+81」，必须在领取前额外读一次 `task/list` 取 `totalUngetScore`，那会把 happy path 从 1 个请求变成 2 个 —— 按「每天只调用一次」的约束，本方案选择不读。要恢复这个显示，改动量是在 `claimVipGrowth` 前加一次读并多存一个 `gained` 字段。

单任务开关（Phase 3 的 popup 用得到）：`taskEnabled = { [key]: boolean }`，缺省 `true`（`vipGrowth` 也默认开 —— 它已被窗口和日期门双重限制住，不需要再靠开关兜底）。

### 5.5 文件与改动点清单（落地阶段执行，本方案不动任何文件）

| 文件 | 动作 | 实际落地内容 |
|---|---|---|
| `weapi.js` | **新增** | §5.2 加密层 + §5.3 请求层 `weapiRequest(host, path, data, csrfToken, query)`。全文件不引用 `chrome.*`，以便在 Node 下直接测。 |
| `background.js` | **改** | 5 个任务函数 + `TASKS` 任务表 + `runBatch`/`shouldRunNight` 两批调度；新增 `ALARM_VIP_CLAIM` 与 `scheduleVipClaim()`；storage 键换成 `taskDoneOn` / `vipGrowthLog`，**废弃 `lastOpenedDate` 与 `performCheckIn`**。 |
| `build.js` | **改** | `ASSETS_TO_COPY` 加 `weapi.js`；Firefox 的 `background.scripts` 改为 `["weapi.js", "background.js"]`。 |
| `manifest.base.json` | **只改版本号** | `1.0.0 → 1.1.0`。`host_permissions` 与 `permissions` 一字未动 —— 通配已覆盖 `interface`/`interface3` 子域。 |
| `tests/weapi.test.mjs` | **新增** | §7 的离线等价测试（6 项）。 |
| `tests/orchestration.test.mjs` | **新增** | 调度门控行为测试（11 项）。 |
| `README.md` | **改** | 中英功能列表、使用说明（21:00 窗口）、隐私说明（新增两条：只发往 music.163.com、本地账目不含任务名）、开发命令。 |
| `popup.html` / `popup.js` | **未做** | P3，见 §5.6。 |
| `LICENSE` | 不动 | GPL-3.0 已在。 |

**与本方案原稿的两处偏差（均为实现期发现，已验证）**：

1. **没有坚持单文件**。原稿 §5.5 建议全部塞进 `background.js`，但那样加密层无法在 Node 里单独测（`background.js` 顶层就调 `chrome.*`）。拆出 `weapi.js` 后，Chrome 走 `importScripts`、Firefox 走 `background.scripts` 数组，两条加载路径都有测试覆盖。
2. **`importScripts` 必须加存在性判断**。`typeof importScripts === "function"` 之前是无条件调用，而 Firefox 的 `background.scripts` 上下文里没有这个函数，会直接抛错让整个后台脚本挂掉 —— 这是实现期发现的真实跨浏览器缺陷，不是推测。

### 5.6 UI（Phase 3，可推迟）

图一那种"卡片 + 进度点"的完整复刻**不建议做** —— 需要额外读 4 条展示接口、要画日历组件、要处理会员态差异，收益低。建议只做**最小控制面板**：

```
[✓] 每日签到（云贝）        今日：已签到 · 连签 12 天
[✓] 黑胶乐签                今日：未签 · 本月已签 6 天
[✓] 成长值一键领取 21:00后   今日：未领 · 待领取 +81
[ 立即执行 ]          最近运行：2026-10-05 00:00:12
```

第三条的 `21:00后` 是把自动触发条件直接标在开关上，避免"为什么没领"的困惑。手动点「立即执行」时**忽略窗口、但保留"当天只调用一次"** —— 白天想提前领由你自己决定，扩展不会替你把一天领两次。

实现约束：
- `manifest.base.json` 的 `action` 加 `default_popup` → **`chrome.action.onClicked`（`background.js:265-273`）随即失效**，`isEnabled` 开关必须搬进 popup 做成 checkbox，图标切换改由 `chrome.storage.onChanged` 驱动。
- popup 不自己发请求，通过 `chrome.runtime.sendMessage({type:'runNow'})` 让 service worker 执行（保持"只有 worker 碰网络"这一条清晰边界），结果从现有 `runtimeLogs`（`background.js:5`）读。
- 可选：整批跑完发一条聚合通知（复用 `chrome.notifications`，无新权限），把"签到成功 +3 云贝 / 乐签成功 / 成长值 +81"合并成一条，替代现在只有登录提醒的静默行为。

---

## 6. 里程碑

**当前进度：P0 / P1 / P2 已完成**（`node --test` 17/17 通过，`node build.js` 双端产物正常）。P3 popup、P4 商店发布材料未做。

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| **P0 加密层** | `background.js` 内 weapi 加密 + 请求层 | **离线等价测试通过**（§7），不依赖网络。 |
| **P1 图一** | 云贝签到 + 连签阶段奖励 + 黑胶乐签，静默跑，日志输出 | `node build.js` 通过；加载 `dist/chrome` 无 manifest 报错；离线测试仍通过；逐条检查新增 `logInfo/logWarn` 的 `details` 里没有 cookie / `__csrf` / 密文。 |
| **P2 图二** | 成长值一键领取，**21:00–23:59 硬窗口 + 每天最多一次 + 成功落 `vipGrowthLog`** | 同上；窗口外（00:00–20:59）任何入口触发都零请求；当天已领过时重启浏览器不再发请求；`chrome.storage.local` 里 `vipGrowthLog` 只有 `{d,gained,code,ts}`，无任务名/歌曲名。 |
| **P3 UI** | popup 控制面板 + `onClicked` 逻辑迁移 | popup 打开、开关持久化、"立即执行"生效。 |
| **P4 发布** | README 中英同步、版本号 1.1.0、双端产物 | Chrome Web Store / AMO 重新提交材料就绪。 |

P1 与 P2 之间建议留一段真实观察期（看日志里 `code`/`message` 是否出现预期外分支），再决定 P2 是否默认开启。

---

## 7. 验证策略（不需要真实账号，也不需要人肉眼验）

**核心可离线验证的命题**：扩展里的 WebCrypto+BigInt 实现，必须和一条**完全独立的实现**产出逐字节相同的 `params` / `encSecKey`。

做法：固定 `secretKey` 为 `abcdefghij012345`（刻意不用回文串，否则测不出"反转后再送 RSA"这一步）+ 固定 payload，两侧比对。参考侧不依赖 `NeteaseMusic-API-main`（它要先装 `node_modules`），改用 Node 内置 `crypto` 现算：两层 AES-128-CBC + `publicEncrypt(RSA_NO_PADDING)`，与扩展的 WebCrypto + BigInt 模幂没有任何共享代码。

```bash
node --test          # 18 项，全程不联网、不碰 chrome.*
```
比对点：
1. `params` 两层 CBC 结果一致（覆盖 base64 / PKCS#7 / UTF-8 处理）
2. `encSecKey` 256 位 hex、左补零一致（覆盖 `FillBytes` 语义，`crypto.go:263`）
3. 中文/emoji payload 一致（覆盖 UTF-8 字节序）
4. 空对象 `{}` payload 一致（本方案 4 条链里 3 条就是这个形态）

这个测试值得作为仓库第一个自动化测试落地（当前无测试、无 `package.json`）：一个 `tests/weapi.test.mjs` + `node --test` 即可，不引入测试框架。

**线上部分**（响应字段名、`code` 取值分布）只能靠真实账号确认，本方案按"未验"处理，并在 §5.3 的错误分类里把所有未知 `code` 归为"记日志 + 不重试"，保证即使字段判断有偏差也不会造成重试风暴或重复领取。附录 B 留了一个 DevTools 探针片段，落地阶段可选地用它一次性把 4 条链的真实响应打出来。

---

## 8. 未验项清单（一次性列清，不逐条追问）

| # | 未验项 | 影响 | 结论 |
|---|---|---|---|
| 1 | 扩展 service worker 发出的 weapi 请求（无 `Referer`、`Origin: chrome-extension://…`、`Sec-Fetch-Site: none`）是否被网易风控拦截 | 曾是 P0/P1 阻塞性风险 | ✅ **已验，2026-10-05 13:50 真机运行**：`pointmall/user/sign`、`sign/config`、`interface3.../vip-center-bff/task/sign` 三个 weapi 端点全部返回 `code:200` 并被正确解出，`Referer`/`UA` 不需要伪造，`declarativeNetRequest` / `scripting` 退路均不必启用。 |
| 2 | `pointmall/user/sign` 等接口是否也接受现有那种明文 `/api/` POST | 若接受，P1 可以完全不写加密 | 未探（按 weapi 实现已完成，无必要） |
| 3 | 乐签对非黑胶 VIP 账号返回什么 | 影响日志文案 | ⏳ **未验**：验证所用账号本身就带 VIP 权益（`growhpoint/basic` 的 `vipType`/`latestVipStatus` 可见），所谓"已验"只是 `code:200 + data:true` 的回执，而该回执并不等价于落签（见 #7）。Go 侧「Music Sign 不要求 VIP 权益」的注释仍按未证事实对待 |
| 4 | `reward/getall` 的返回形态 | P2 判定依据 | ✅ **成功路径已验**（2026-10-05 22:56 真机）：返回 `code:200 + data.result === true`，日志「VIP 成长值：领取成功」，与 Go 结构体一致。⏳ 非会员 / 已满级 / 达本月 300·400 上限三种分支仍未验（验证时所用账号是有权益且未满级），但这三条只影响日志文案，不影响正确性 —— 未知 `code` 一律归到"记日志、不重试" |
| 5 | 满勤签到抽奖 `extraLotteryId` 的领取语义 | 少一个可选奖励 | 本期不做（Go 项目自己也是 Pending，`sign.go:146`） |
| 6 | 连签阶段奖励是否存在"必须手动点领奖"的时间窗 | 可能漏领 | ✅ 部分已验：本机 `sign/config` 返回 200 且无待领项，日志「云贝连签奖励：无待领」（10-07 00:01 首次真领到：`已领取 1/1`） |
| 7 | `task/sign` 的 `data:true` 到底代表什么 | 决定成功判据 | ✅ **已验（2026-10-07 凌晨）**：只代表任务态被翻转（`vip-center-bff/task/list` 乐签条目 `status:100`、`growhpoint/basic` 的 `todayScore` +3），**不保证生成乐签记录行**。eapi 形态即"翻了任务态但 `recordId` 仍为 0"；且任务态置为已打卡后当天再打只是空转（00:38 用 weapi 重打，`recordId` 不变）。已签的唯一可靠判据是卡片 `signInfoList[].sign` / `sign/info.recordId>0` |

---

## 9. 运行形态：必须开着浏览器吗？

**必须。这是浏览器扩展的硬限制，不是本方案的实现缺陷。**

| 场景 | 会不会签到 | 机制 |
|---|---|---|
| 浏览器进程在跑（窗口最小化、后台、没开网易云网页都算） | ✅ 到点自动签 | `chrome.alarms` 次日 `00:00:05` 唤醒 service worker（`background.js:140-146`、`275-277`） |
| 00:00 时浏览器关着，当天晚些时候打开 | ✅ **补跑一次** | `chrome.runtime.onStartup` → `checkAndRun()`（`background.js:295`）+ 日期门 `lastOpenedDate !== today`（`:240-241`） |
| 电脑睡眠/休眠，浏览器"开着"但被挂起 | ⏸ 唤醒后补跑 | 挂起期间不触发定时器 |
| 一整天没打开过浏览器 | ❌ **不会签** | 扩展没有任何进程在，MV3 无法注册 OS 级计划任务 |
| 浏览器开着但扩展被禁用/图标灰色 | ❌ | `isEnabled === false` 直接跳过（`background.js:235-238`） |

补充两点：
- MV3 service worker 空闲 30 秒会被回收，但 `alarms` 能把它唤醒 —— 所以"常驻"的代价只是浏览器进程，不是内存。
- 网页端和 PC 客户端**共享同一个签到状态**。任一端签过，另一端读到的就是"已签到"（`-2` / `data.sign === false`），本方案按"已完成"归类并跳过，不会重复请求也不会报错。所以如果你当天开过网易云 PC 客户端，扩展那天就是空转。

### 9.1 若要求"完全不开浏览器也能签"

| 方案 | 说明 | 与隐私原则是否冲突 | 建议 |
|---|---|---|---|
| **A. 本地 Windows 任务计划 + `ncmctl`** | 参考仓库自带 `ncmctl task --sign --sign.cron "0 10 * * *"`（`netease-cloud-music-master/internal/ncmctl/task.go:110-112`），登录态从 `cookie.json` 读（`pkg/cookie/cookie.go:63`）。开机即签，与浏览器无关 | ✅ 不冲突（凭据留在本机） | ~~推荐~~ → **2026-10-05 决定不采用**（见下方立场段） |
| B. 浏览器开机自启 + 最小化常驻 | `edge/chrome --start-minimized`，扩展照常工作 | ✅ 不冲突 | 折中，但要接受浏览器进程常驻 |
| C. NAS / VPS / Docker 容器 cron | Go 项目有 `make build-image` + `make task` 容器化任务 | ⚠️ **冲突**：要把 `MUSIC_U` 等凭据存到另一台机器 | 除非是自家内网机器，否则不采用 |
| D. 扩展 + native messaging 反向唤醒 | 外部计划任务唤起浏览器 | ❌ 复杂度高，收益不如 A | 不考虑 |

**本方案的立场（2026-10-05 定稿）**：维护者每天本来就会打开浏览器，所以**不采用 A/B/C/D 任何一种脱离浏览器的路径**，扩展保持"浏览器开着就全自动、错过就补跑"这一档，不扩权限、不改形态、不引入 `ncmctl` 这条并行实现。

这条决定对**图二的晚间窗口**有一个直接后果，必须一起接受：`21:00–23:59` 是"浏览器恰好在那两小时里活着"的窗口，比 morning 批的"当天任意时刻开就补跑"严格得多。整晚没开浏览器 → 当天不领。之所以这个损失可以接受，是因为**成长值不会过期、会累积到下次窗口一并领走**（`reward/getall` 领的是当前所有待领项），所以硬性窗口不需要任何补偿或补跑机制 —— 这也是 §5.4 里"跳过当天、不补跑"是安全设计而非功能缺失的原因。

---

## 附录 A：本方案涉及的完整端点清单（全部 weapi）

| Host | 路径 | 请求体 | 用途 | 阶段 |
|---|---|---|---|---|
| `music.163.com` | `/weapi/pointmall/user/sign` | `{}` | 云贝签到 | P1 |
| `music.163.com` | `/weapi/pointmall/user/sign/config` | `{}` | 连签阶段奖励列表 | P1 |
| `interface.music.163.com` | `/weapi/pointmall/user/sign/lottery/get` | `{"userLotteryId":"<id>"}` | 领取阶段奖励 | P1 |
| `music.163.com` | `/weapi/pointmall/sign/calendar` | `{}` | 连签日历（展示） | P3 可选 |
| `music.163.com` | `/weapi/point/signed/get` | `{}` | 累计天数/云贝（展示） | P3 可选 |
| `interface3.music.163.com` | `/weapi/vip-center-bff/task/sign?isNew=` | `{}` | 黑胶乐签打卡 | P1 |
| `interface3.music.163.com` | `/weapi/vipnewcenter/app/user/sign/info` | `{}` | 乐签状态（展示） | P1/P3 |
| `interface3.music.163.com` | `/weapi/vipnewcenter/app/minidesk/music/sign/pc` | `{"type":"0"\|"1"}` | 乐签日历卡片（展示） | P3 可选 |
| `music.163.com` | `/weapi/vipnewcenter/app/level/growhpoint/basic` | `{}` | VIP 权益/满级门禁 | P2 |
| `interface3.music.163.com` | `/weapi/vipnewcenter/app/user/max/score` | `{}` | 本月成长值上限门禁 | P2 |
| `music.163.com` | `/weapi/vipnewcenter/app/level/task/list` | `{}` | 成长任务/待领数值 | P2 |
| `music.163.com` | `/weapi/vipnewcenter/app/level/task/reward/getall` | `{}` | **一键领取成长值** | P2 |

全部 host 由现有 `*://*.music.163.com/*`（`manifest.base.json:26`）覆盖。

## 附录 B：DevTools 探针（落地阶段可选，在 music.163.com 已登录页面的 Console 里跑）

同源、cookie 自动带上、无需扩展权限，用来一次性打真实响应形态：

```js
const csrf = document.cookie.match(/__csrf=([^;]+)/)?.[1] ?? '';
const P = { iv:'0102030405060708', pk:'0CoJUm6Qyw8W8jud',
  b62:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' };
const enc = async (t,k) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.encrypt(
  {name:'AES-CBC',iv:new TextEncoder().encode(P.iv)},
  await crypto.subtle.importKey('raw',new TextEncoder().encode(k),{name:'AES-CBC'},false,['encrypt']),
  new TextEncoder().encode(t)))));
const N = 0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7n;
const rsa = (s) => { let v=0n; for(const c of s) v=(v<<8n)|BigInt(c.charCodeAt(0));
  let r=1n,b=v%N,e=65537n,m=N; while(e>0n){ if(e&1n)r=r*b%m; b=b*b%m; e>>=1n; }
  return r.toString(16).padStart(256,'0'); };
const call = async (host, path, data={}) => {
  const sk = Array.from(crypto.getRandomValues(new Uint8Array(16)), x=>P.b62[x%62]).join('');
  const params = await enc(await enc(JSON.stringify({...data, csrf_token:csrf}), P.pk), sk);
  const r = await fetch(`https://${host}${path}?csrf_token=${csrf}`, { method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({params, encSecKey:rsa([...sk].reverse().join(''))}) });
  return { status:r.status, json: await r.json().catch(()=>null) };
};
// 只读探测（无副作用）：
// await call('music.163.com','/weapi/pointmall/user/sign/config')
// await call('interface3.music.163.com','/weapi/vipnewcenter/app/user/sign/info')
// await call('music.163.com','/weapi/vipnewcenter/app/level/task/list')
// 有副作用（会真实签到/领奖），确认后再跑：
// await call('music.163.com','/weapi/pointmall/user/sign')
// await call('interface3.music.163.com','/weapi/vip-center-bff/task/sign?isNew=')
// await call('music.163.com','/weapi/vipnewcenter/app/level/task/reward/getall')
```

## 附录 C：参考实现索引

| 主题 | 位置 |
|---|---|
| 官方签到编排顺序（最有价值的"抄作业"文件） | `netease-cloud-music-master/internal/ncmctl/sign.go:72-286` |
| weapi 算法（Go） | `netease-cloud-music-master/pkg/crypto/crypto.go:324-353`，`RsaEncrypt` `244-265` |
| weapi 算法（JS，与扩展最接近） | `NeteaseMusic-API-main/util/crypto.js:13-28, 56-71` |
| weapi 请求装配（csrf / Referer / UA / URL 拼接） | `NeteaseMusic-API-main/util/request.js:158-206`；Go 侧 `api/api.go:508-539` |
| 云贝接口集合 | `netease-cloud-music-master/api/weapi/yunbei.go`（签到 299 / 阶段奖 756 / 领奖 909 / 日历 668） |
| VIP 乐签 + 成长值接口集合 | `netease-cloud-music-master/api/weapi/vip.go`（打卡 1311 / 信息 593 / 任务列表 136 / 一键领取 70 / 上限 627） |
| 乐签 wire 级断言（参数类型、签名内层路径） | `netease-cloud-music-master/api/vip_sign_test.go:204-304` |
| 每日签到返回码语义 | `NeteaseMusic-API-main/module/daily_signin.js:3-8`（`200` 成功 / `-2` 重复签到 / `301` 未登录） |
