importScripts("weapi.js");

const TARGET_URL = "https://music.163.com/";
const BUFFER_TIME_MS = 2000;
// 会话刷新标签页的兜底关闭时限：onUpdated 的 complete 可能永远不到（见 executeSuccessTask）。
const TAB_CLOSE_FALLBACK_MS = 30000;
const ALARM_NAME = "smartDailyNetEaseCheck";
// 晚间批共用这一个闹钟：乐签复核补打 + 云贝任务奖励领取 + 成长值领取（21:00–23:59 硬窗口）。
const ALARM_VIP_CLAIM = "netEaseVipGrowthClaim";
const LOGIN_NOTIFICATION_ID = "netease_login_needed";
const LOG_STORAGE_KEY = "runtimeLogs";
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_MAX_ENTRIES = 2000;
// 单条日志的正文上限：details 里会原样落服务端自由文本（如 message），一条超长响应就能把
// storage.local 的 10 MiB 吃到威胁日期门的写入。超限的条目降级成一个短对象，不丢时间戳和结论。
const LOG_DETAILS_MAX_CHARS = 512;

const MUSIC_HOST = "music.163.com";
const INTERFACE_HOST = "interface.music.163.com";
const VIP_CENTER_HOST = "interface3.music.163.com";

// 云贝任务奖励与成长值要等白天攒进度，乐签复核也要给服务端留出写流水的时间，所以这些动作固定在本地时间 21:00 之后。
const VIP_CLAIM_HOUR = 21;
// 晚批还有缺门的任务时，当晚每隔这么多分钟再排一次；越过 23:59 才顺延次日。
// 没有这条重排，21:30 那一次跑完后当晚剩余触发点为 0，一次网络抖动就等于断签一天。
const NIGHT_RETRY_MINUTES = 20;
const TASK_STATE_KEY = "taskDoneOn";
const VIP_GROWTH_LOG_KEY = "vipGrowthLog";
const VIP_GROWTH_LOG_MAX = 60;

// 成长值流水是「乐签有没有被计入」的唯一依据。判否定结论必须翻到流水尽头，所以这里只是**上限**，
// 实际读了几页会写进日志（稳态命中即返回，通常 1 页）。理由见 hasMusicSignLedgerEntry。
const LEDGER_PAGE_SIZE = 40;
const LEDGER_MAX_PAGES = 5;
// 计入判据：条目名以「黑胶乐签每日打卡」开头 + 成长值恰为 3。
// 只按「乐签」两个字匹配会把 10-11 00:34:09.779 那条「黑胶乐签阶梯奖励 +30」当成每日打卡，
// 于是复核写「今日已计入」、当天唯一的补打机会被吞掉 —— 判据宁窄勿宽。
const MUSIC_SIGN_ENTRY_PREFIX = "黑胶乐签每日打卡";
const MUSIC_SIGN_GROWTH_POINT = 3;
// 打卡请求发出后，服务端写流水条目实测在几秒内完成（10-10 条目 00:00:04.946 / 日志 00:00:06）。
// 同一次跑批里晨批刚打完、晚批立刻复核时不能把「还没落地」读成缺口，给这么长的静置期。
const PUNCH_SETTLE_MS = 10 * 60 * 1000;

let logWriteQueue = Promise.resolve();

function normalizeError(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    try {
        return JSON.stringify(err);
    } catch (_) {
        return String(err);
    }
}

// 抛出点的头两行栈：瞬态通道同时接网络失败和任务内部缺陷，没有它就分不清是哪种。
function firstStackLine(err) {
    return typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 3).join(" | ") : "";
}

// chrome 的回调式 API 只把失败写进 runtime.lastError，不读它就像没读到错误。
// 全仓 13 处回调式调用原先只有 1 处读它 ⇒「登录提醒已发出」「闹钟已排好」在失败时说得像成功。
function chromeFailed(op, context) {
    const err = chrome.runtime.lastError;
    if (!err) return false;
    logWarn(`${op} 失败：${err.message}`, context);
    return true;
}

// 单条日志的 details 统一设上限：服务端 message 是自由文本，整段落盘会挤掉 storage 配额。
function clampDetails(details) {
    if (typeof details === "string") return details.slice(0, LOG_DETAILS_MAX_CHARS);
    if (details === undefined || details === null) return null;
    if (typeof details !== "object") return details;
    let json;
    try {
        json = JSON.stringify(details);
    } catch (_) {
        return String(details).slice(0, LOG_DETAILS_MAX_CHARS);
    }
    if (json === undefined) return null;
    return json.length <= LOG_DETAILS_MAX_CHARS ? details : { truncated: json.slice(0, LOG_DETAILS_MAX_CHARS) };
}

function enqueuePersistentLog(level, message, details) {
    const entry = {
        ts: Date.now(),
        level,
        message,
        details: clampDetails(details)
    };

    logWriteQueue = logWriteQueue
        .then(() => new Promise((resolve) => {
            // 日志通道自己不能递归调用 logWarn（那又要写日志），失败只走 console。
            chrome.storage.local.get([LOG_STORAGE_KEY], (res) => {
                if (chrome.runtime.lastError) {
                    console.error("Persistent log read failed:", chrome.runtime.lastError.message);
                    return resolve();
                }
                const rawLogs = Array.isArray(res[LOG_STORAGE_KEY]) ? res[LOG_STORAGE_KEY] : [];
                const cutoff = Date.now() - LOG_RETENTION_MS;
                const recentLogs = rawLogs.filter((item) => item && typeof item.ts === "number" && item.ts >= cutoff);
                recentLogs.push(entry);
                if (recentLogs.length > LOG_MAX_ENTRIES) {
                    recentLogs.splice(0, recentLogs.length - LOG_MAX_ENTRIES);
                }

                chrome.storage.local.set({ [LOG_STORAGE_KEY]: recentLogs }, () => {
                    if (chrome.runtime.lastError) {
                        console.error("Persistent log write failed:", chrome.runtime.lastError.message);
                    }
                    resolve();
                });
            });
        }))
        .catch((err) => {
            console.error("Persistent log write failed:", err);
        });
}

function logInfo(message, details) {
    if (details !== undefined) {
        console.log(message, details);
    } else {
        console.log(message);
    }
    enqueuePersistentLog("info", message, details);
}

function logWarn(message, details) {
    if (details !== undefined) {
        console.warn(message, details);
    } else {
        console.warn(message);
    }
    enqueuePersistentLog("warn", message, details);
}

function logError(message, details) {
    if (details !== undefined) {
        console.error(message, details);
    } else {
        console.error(message);
    }
    enqueuePersistentLog("error", message, details);
}

function pruneLogs(callback) {
    chrome.storage.local.get([LOG_STORAGE_KEY], (res) => {
        if (chrome.runtime.lastError) {
            console.error("Log prune read failed:", chrome.runtime.lastError.message);
            if (typeof callback === "function") callback([]);
            return;
        }
        const rawLogs = Array.isArray(res[LOG_STORAGE_KEY]) ? res[LOG_STORAGE_KEY] : [];
        const cutoff = Date.now() - LOG_RETENTION_MS;
        const recentLogs = rawLogs.filter((item) => item && typeof item.ts === "number" && item.ts >= cutoff);
        chrome.storage.local.set({ [LOG_STORAGE_KEY]: recentLogs }, () => {
            if (chrome.runtime.lastError) {
                console.error("Log prune write failed:", chrome.runtime.lastError.message);
            }
            if (typeof callback === "function") callback(recentLogs);
        });
    });
}

function printSavedLogs() {
    pruneLogs((logs) => {
        console.group(`NetEaseMusicActivator logs (last 7 days, count=${logs.length})`);
        if (logs.length === 0) {
            console.log("No logs in the last 7 days.");
            console.groupEnd();
            return;
        }

        console.table(
            logs.map((item, index) => ({
                index: index + 1,
                time: new Date(item.ts).toLocaleString(),
                level: item.level,
                message: item.message,
                details: item.details == null ? "" : (typeof item.details === "string" ? item.details : JSON.stringify(item.details))
            }))
        );
        console.groupEnd();
    });
}

globalThis.printSavedLogs = printSavedLogs;
globalThis.printNeteaseLogs = printSavedLogs;

/**
 * Storage & Cookie helpers
 * storageGet 读失败返回 null（不是 {}）：把「读不到状态」当成「什么都没做过」会让当天所有接口重打一遍。
 * storageSet 返回是否真的落盘，调用方据此决定要不要把这一步当已完成。
 */
function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (res) => {
        resolve(chromeFailed("storage.local.get", { keys }) ? null : (res || {}));
    }));
}

function storageSet(entries) {
    return new Promise((resolve) => chrome.storage.local.set(entries, () => {
        resolve(!chromeFailed("storage.local.set", { keys: Object.keys(entries) }));
    }));
}

function getCookie(name) {
    return new Promise((resolve) => {
        chrome.cookies.get({ url: TARGET_URL, name }, (cookie) => {
            if (chromeFailed("cookies.get", { name })) return resolve("");
            resolve(cookie ? cookie.value : "");
        });
    });
}

function localDate(date) {
    return date.toDateString();
}

// 服务端 sign/info 用 ISO 形态的日期串当键（"2026-10-08"），与 localDate 的 toDateString 不通用。
function isoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Icon Paths
const ICONS_RED = {
    "16": "images/red16.png",
    "48": "images/red48.png",
    "128": "images/red128.png"
};
const ICONS_GRAY = {
    "16": "images/gray16.png",
    "48": "images/gray48.png",
    "128": "images/gray128.png"
};

/**
 * UI & Icon Manager
 */
function updateUI(isEnabled) {
    const path = isEnabled ? ICONS_RED : ICONS_GRAY;
    const title = isEnabled ? "NetEaseMusicActivator: Active" : "NetEaseMusicActivator: Disabled (Click to enable)";
    chrome.action.setIcon({ path }, () => chromeFailed("action.setIcon", { isEnabled }));
    chrome.action.setTitle({ title }, () => chromeFailed("action.setTitle", { isEnabled }));
}

/**
 * 排闹钟并如实报告结果：create 不读 lastError 时，「已排到明天 21:00」这句日志在失败时照样会写。
 */
function createAlarm(name, when, label) {
    chrome.alarms.create(name, { when }, () => {
        if (chromeFailed("alarms.create", { name })) return;
        logInfo(label, new Date(when).toLocaleString());
    });
}

/**
 * Schedule next run at 00:00:05 of the next day
 */
function scheduleNextRun() {
    const nextRun = new Date();
    nextRun.setHours(24, 0, 5, 0);
    createAlarm(ALARM_NAME, nextRun.getTime(), "Next check scheduled at");
}

/**
 * Schedule the evening batch (sign verify / yunbei tasks / growth claim) for the next 21:00 local.
 * retryWithinWindow=true 时先在 21:00–23:59 窗口内 +N 分钟重排一次，给瞬态失败留当晚的修复机会。
 */
function scheduleVipClaim(retryWithinWindow) {
    const now = new Date();
    const nextRun = new Date(now.getTime());
    if (retryWithinWindow) {
        nextRun.setMinutes(now.getMinutes() + NIGHT_RETRY_MINUTES, 0, 0);
        if (nextRun.getDate() === now.getDate() && nextRun.getHours() >= VIP_CLAIM_HOUR) {
            createAlarm(ALARM_VIP_CLAIM, nextRun.getTime(), "Evening batch retry scheduled at");
            return;
        }
        nextRun.setTime(now.getTime());
    }
    nextRun.setHours(nextRun.getHours() >= VIP_CLAIM_HOUR ? 24 + VIP_CLAIM_HOUR : VIP_CLAIM_HOUR, 0, 0, 0);
    createAlarm(ALARM_VIP_CLAIM, nextRun.getTime(), "Next evening batch scheduled at");
}

/**
 * SW 重启不会重跑排程逻辑，而 chrome.alarms 只有 create + onAlarm 两个面：
 * 闹钟被清（配额、profile 迁移）时不会自愈，扩展就再也不跑了。初始化按名字对账补排。
 */
function ensureAlarms() {
    chrome.alarms.get(ALARM_NAME, (alarm) => {
        if (chromeFailed("alarms.get", { name: ALARM_NAME })) return;
        if (!alarm) scheduleNextRun();
    });
    chrome.alarms.get(ALARM_VIP_CLAIM, (alarm) => {
        if (chromeFailed("alarms.get", { name: ALARM_VIP_CLAIM })) return;
        if (!alarm) scheduleVipClaim(false);
    });
}

/**
 * API Check-in Logic
 * 每个任务返回 { done, needLogin, message, details }：
 * done=true 的含义是「这一天已经拿到确定结论」，只有它才写当天日期门；needLogin=true 会中止整批并触发登录提醒。
 * 接口拒绝不是结论，只是这一次没成功 ⇒ done=false，留给当晚下一次触发重试（PLAN-musicsign-verdict.md 定的就是「非 200 不写门」）。
 * 哪些拒绝码其实是终态 = 无服务端样本，UNKNOWN；所以现在一个都不特判，宁可多试也不要吞掉修复机会。
 */
const NOT_LOGGED_IN = 301;

function notLoggedIn(code, label) {
    return code === NOT_LOGGED_IN ? { done: false, needLogin: true, message: `${label}：未登录` } : null;
}

function rejected(code, label) {
    return { done: false, message: `${label}：接口拒绝（本轮未落门，等下次触发重试）`, details: { code } };
}

async function signDailyTask() {
    const csrfToken = await getCookie("__csrf");
    const params = new URLSearchParams({ type: "1" });
    if (csrfToken) params.append("csrf_token", csrfToken);

    const response = await fetch(`https://${MUSIC_HOST}/api/point/dailyTask?type=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        body: params
    });
    const data = await response.json();
    // 与 weapiRequest 同一条例外：信封缺 code 时 `data.code === 200` 之类的哨兵会静默走空，
    // 「没读到结论」不能被写成结论。抛出去由 runBatch 按瞬态处理（不写门、下次重试）。
    if (typeof data.code !== "number") throw new Error("响应缺少 code 字段 /api/point/dailyTask");

    if (data.code === 200) return { done: true, message: "每日签到成功", details: { point: data.point } };
    if (data.code === -2) return { done: true, message: "每日签到：今日已签" };
    return notLoggedIn(data.code, "每日签到") || rejected(data.code, "每日签到");
}

async function signYunbei() {
    const data = await weapiRequest(MUSIC_HOST, "/weapi/pointmall/user/sign", {}, await getCookie("__csrf"));
    if (data.code !== 200) return notLoggedIn(data.code, "云贝签到") || rejected(data.code, "云贝签到");

    return data.data && data.data.sign
        ? { done: true, message: "云贝签到成功" }
        : { done: true, message: "云贝签到：今日已签" };
}

async function claimYunbeiStages() {
    const csrfToken = await getCookie("__csrf");
    const config = await weapiRequest(MUSIC_HOST, "/weapi/pointmall/user/sign/config", {}, csrfToken);
    if (config.code !== 200) return notLoggedIn(config.code, "云贝连签奖励") || rejected(config.code, "云贝连签奖励");

    const pending = ((config.data && config.data.lotteryConfig) || [])
        .filter((stage) => stage.baseLotteryId > 0 && stage.baseLotteryStatus === 0);
    if (pending.length === 0) return { done: true, message: "云贝连签奖励：无待领" };

    let claimed = 0;
    for (const stage of pending) {
        const reply = await weapiRequest(
            INTERFACE_HOST,
            "/weapi/pointmall/user/sign/lottery/get",
            { userLotteryId: String(stage.baseLotteryId) },
            csrfToken
        );
        if (reply.data === true) claimed++;
    }

    return { done: true, message: `云贝连签奖励：已领取 ${claimed}/${pending.length}`, details: { claimed } };
}

async function claimYunbeiTasks() {
    const csrfToken = await getCookie("__csrf");
    const todo = await weapiRequest(MUSIC_HOST, "/weapi/usertool/task/todo/query", {}, csrfToken);
    if (todo.code !== 200) return notLoggedIn(todo.code, "云贝任务") || rejected(todo.code, "云贝任务");

    const completed = (Array.isArray(todo.data) ? todo.data : [])
        .filter((task) => task && task.completed === true);
    if (completed.length === 0) return { done: true, message: "云贝任务：无待领" };

    // 官方"一键领取"同样是逐个调 point/receive；只领已完成的任务奖励，不代做任务本身。
    let claimed = 0;
    for (const task of completed) {
        const reply = await weapiRequest(MUSIC_HOST, "/weapi/usertool/task/point/receive", {
            period: String(task.period),
            userTaskId: String(task.userTaskId),
            depositCode: String(task.depositCode)
        }, csrfToken);
        if (reply.code === 200 && reply.data === true) claimed++;
    }

    return {
        done: true,
        message: `云贝任务：已领取 ${claimed}/${completed.length} 项`,
        details: { claimed, total: completed.length }
    };
}

// 乐签打卡用 weapi 形态（interface3 + csrf）。打卡请求本身是有效的：10-05 12:07:30、10-06 00:08:07、
// 10-07 00:01:20、10-08 00:00:07 四条服务端记录行的 time 都逐秒等于当天的打卡时刻，
// 其中前三天账号只在客户端被动收签到结果、没有做过任何手动打卡。
// 【服务端观察，非协议保证】上述对应关系只到 2026-10-08 的 4 条样本，取证表格见 PLAN-musicsign-verdict.md §1（只读探针原文）；
// 它支撑「这个形式能打出请求」，不支撑「服务端永远按这个时刻写行」。
async function requestVipSignPunch() {
    return weapiRequest(VIP_CENTER_HOST, "/weapi/vip-center-bff/task/sign", {}, await getCookie("__csrf"));
}

// "2026-10-09" → 本地日界 [当天 00:00:00.000, 次日 00:00:00.000)。
// new Date("2026-10-09") 这种只有"日"粒度的串会按 UTC 解析，isoDate 的输出正好踩这条，所以拆数字构造。
// 日界两侧零 padding：判据本身没有余量，全部缓冲来自 00:00:05 的排程（实测流水时刻与打卡时刻差 ±2.1s ⇒ 净缓冲约 2.9s）。
function dayBounds(day) {
    const [year, month, date] = day.split("-").map(Number);
    return [new Date(year, month - 1, date).getTime(), new Date(year, month - 1, date + 1).getTime()];
}

function isMusicSignEntry(item, from, to) {
    return Boolean(item)
        && typeof item.time === "number" && item.time >= from && item.time < to
        && typeof item.descript === "string" && item.descript.startsWith(MUSIC_SIGN_ENTRY_PREFIX)
        && item.growthPoint === MUSIC_SIGN_GROWTH_POINT;
}

// 乐签计入的唯一依据：成长值流水里那一天有一条「黑胶乐签每日打卡 +3」条目。
// 不再用 sign/info 的 recordId —— 它属于另一条更慢、且会整段不出的唱片记录行流水线：
// 10-09 流水 00:00:04 已计 +3、monthCheckInTotalDay 也已含它，sign/info 到 +41h 却仍无行。
// counted 三态：true 已计入 / false 已证明那一天没有条目 / null 证据不足（不得当成失败，也不得拿去补打）。
// 返回 { code } 表示非 200，由调用方分「未登录 / 拒绝重试」。
async function hasMusicSignLedgerEntry(day) {
    const [from, to] = dayBounds(day);
    const csrfToken = await getCookie("__csrf");
    const scanned = [];
    let pages = 0;
    let reachedEnd = false;
    // 命中即返回（正向早停与流水排序方向无关）；禁的是**负向**早停 —— 没读到尽头就断言「那天没有」，
    // 在乱序或被分页截断时是假阴性，会把能补的日子说成已无法补救。
    for (let page = 0; page < LEDGER_MAX_PAGES; page++) {
        const reply = await weapiRequest(VIP_CENTER_HOST, "/weapi/vipnewcenter/app/level/growth/details",
            { limit: String(LEDGER_PAGE_SIZE), offset: String(page * LEDGER_PAGE_SIZE) }, csrfToken);
        pages++;
        if (reply.code !== 200) return { code: reply.code };

        const details = reply.data && Array.isArray(reply.data.details) ? reply.data.details : [];
        if (scanned.concat(details).some((item) => isMusicSignEntry(item, from, to))) {
            return { counted: true, pages };
        }
        scanned.push(...details);
        if (!reply.data || reply.data.hasMore !== true) {
            reachedEnd = true;
            break;
        }
    }

    // 覆盖证明的主判据是「翻到了尽头」；辅判据是「条目时间跨度把目标日夹在中间」——
    // 后者只在流水按时间连续排列时成立，那是实测观察、不是协议保证，所以只在主判据拿不到时兜底。
    const bracketed = scanned.some((item) => item && typeof item.time === "number" && item.time >= to)
        && scanned.some((item) => item && typeof item.time === "number" && item.time < from);
    if (reachedEnd || bracketed) return { counted: false, pages, cover: reachedEnd ? "end" : "span" };

    return { counted: null, pages };
}

// 本轮 service worker 内最后一次发出打卡请求的时刻（毫秒）。用它挡住「刚打完就复核、误判成缺口再打一次」；
// SW 被回收后这个记录就没了，那种情况下宁可多打一次（服务端按天去重），也不要漏掉真正的修复机会。
let lastPunchAttemptAt = 0;

async function signVipMusic() {
    lastPunchAttemptAt = Date.now();
    const reply = await requestVipSignPunch();
    if (reply.code !== 200) return notLoggedIn(reply.code, "乐签") || rejected(reply.code, "乐签");
    // data===true 只代表请求被受理；是否计入要看成长值流水，终态由次日晨批核对。
    if (reply.data === true) return { done: true, message: "乐签：打卡请求已受理" };

    return { done: true, message: "乐签：本次未完成", details: { reason: reply.message || "" } };
}

// 本机有没有为那一天（或更晚的一天）参与过打卡。日期门里的 vipSign 值就是最后一次落该门那天的 localDate 形态；
// 目标日早于它，说明扩展那天根本没运行 —— 不能把它说成用户可见的「漏签事故」。
function participatedOn(day, punchedOnGateValue) {
    if (!punchedOnGateValue) return false;
    const last = new Date(punchedOnGateValue);
    if (Number.isNaN(last.getTime())) return false;
    return isoDate(last) >= day;
}

// 晨批第一件事是给昨天出终态：这一天已经过了，流水里没有条目就是真没计入，补也补不了。
async function finalizeVipSign() {
    const prev = new Date();
    prev.setDate(prev.getDate() - 1);
    const day = isoDate(prev);
    const ledger = await hasMusicSignLedgerEntry(day);
    if ("code" in ledger) return notLoggedIn(ledger.code, "乐签终态") || rejected(ledger.code, "乐签终态");
    // 措辞的强度跟着判据走：覆盖不到那天只能声明证据不足，不写"未计入"。
    if (ledger.counted === null) {
        return { done: false, message: `乐签 ${day} 无法判定：流水未覆盖当天`, details: { pages: ledger.pages } };
    }
    if (ledger.counted) return { done: true, message: `乐签 ${day} 已计入`, details: { pages: ledger.pages } };

    const state = await storageGet([TASK_STATE_KEY]);
    const punchedOn = state && state[TASK_STATE_KEY] ? state[TASK_STATE_KEY].vipSign : null;
    if (!participatedOn(day, punchedOn)) {
        // 扩展没参与过的那一天没有「未计入」可言（首次安装日、停用多日后重启都会走到这里）。
        return { done: true, message: `乐签 ${day} 无条目，但本机当天未参与打卡`, details: { pages: ledger.pages } };
    }

    return { done: true, message: `乐签 ${day} 未计入，已过当天无法补`, details: { pages: ledger.pages, cover: ledger.cover } };
}

async function verifyVipSign() {
    const ledger = await hasMusicSignLedgerEntry(isoDate(new Date()));
    if ("code" in ledger) return notLoggedIn(ledger.code, "乐签复核") || rejected(ledger.code, "乐签复核");
    if (ledger.counted === true) return { done: true, message: "乐签复核：今日已计入", details: { pages: ledger.pages } };
    // 读不到流水就不动作：补打是写操作，不能建立在证据不足上。不落门 ⇒ 当晚窗口内的下一次触发再核一次。
    if (ledger.counted === null) {
        return { done: false, message: "乐签复核：流水未覆盖当天，暂不补打", details: { pages: ledger.pages } };
    }

    // 同一次 checkAndRun 里晨批刚打过（间隔几秒），流水大概率还没写行，这不算缺口，补打是空转。
    // 用「不写门」的措辞把判断推迟到当晚下一次触发，而不是直接下结论。
    if (Date.now() - lastPunchAttemptAt < PUNCH_SETTLE_MS) {
        return { done: false, message: "乐签复核：今日打卡请求刚发出，流水尚未落地，本轮不补打", details: { pages: ledger.pages } };
    }

    // 走到这里才是真缺口：晨批那次 data===true 的受理没换成计入。补打是当天唯一的修复机会，
    // 服务端按天去重（10-09 打两次只记一条），所以这次补打不会重复加分。
    lastPunchAttemptAt = Date.now();
    const punch = await requestVipSignPunch();
    if (punch.code !== 200) return notLoggedIn(punch.code, "乐签补打") || rejected(punch.code, "乐签补打");

    return {
        done: true,
        message: punch.data === true
            ? "乐签复核：今日流水无乐签条目，补打请求已受理，终态次日核对"
            : "乐签复核：今日流水无乐签条目，补打本次未完成，终态次日核对",
        details: { punchAck: punch.data === true, pages: ledger.pages }
    };
}

async function claimVipGrowth() {
    const csrfToken = await getCookie("__csrf");
    const reply = await weapiRequest(MUSIC_HOST, "/weapi/vipnewcenter/app/level/task/reward/getall", {}, csrfToken);

    if (reply.code === 200 && reply.data && reply.data.result === true) {
        await recordVipGrowth();
        return { done: true, message: "VIP 成长值：领取成功" };
    }
    if (reply.code === 200) return { done: true, message: "VIP 成长值：无待领" };

    const auth = notLoggedIn(reply.code, "VIP 成长值");
    if (auth) return auth;

    // getall 的响应里没有金额，所以非 200 时只多读一次基础信息用于解释原因。
    // 领取失败不是当天的确定结论 ⇒ done=false，靠窗口内的重排再试；成长值不过期，多试一次没有副作用。
    const detail = await weapiRequest(MUSIC_HOST, "/weapi/vipnewcenter/app/level/growhpoint/basic", {}, csrfToken)
        .catch(() => null);
    const level = detail && detail.data && detail.data.userLevel;

    return {
        done: false,
        message: "VIP 成长值：本轮未领取（接口拒绝，等下次触发重试）",
        details: {
            code: reply.code,
            latestVipStatus: level ? level.latestVipStatus : null,
            maxLevel: level ? level.maxLevel : null
        }
    };
}

/**
 * 领取账目只记日期与结果：getall 响应不含金额，任务名/歌曲名一律不落盘。
 */
async function recordVipGrowth() {
    const stored = await storageGet([VIP_GROWTH_LOG_KEY]);
    if (!stored) {
        logWarn("领取账目未记账：本地状态读取失败");
        return;
    }
    const log = Array.isArray(stored[VIP_GROWTH_LOG_KEY]) ? stored[VIP_GROWTH_LOG_KEY] : [];
    const now = new Date();

    log.push({ d: localDate(now), ts: now.getTime(), ok: true });
    if (log.length > VIP_GROWTH_LOG_MAX) log.splice(0, log.length - VIP_GROWTH_LOG_MAX);
    if (!await storageSet({ [VIP_GROWTH_LOG_KEY]: log })) {
        logWarn("领取账目未落盘", { date: localDate(now) });
    }
}

/**
 * Task Registry
 * 数组顺序承载语义：同一批里先写的任务先有机会落日期门，而 `needLogin` 会 break 掉整批 ——
 * 所以 vipSignFinal 必须排在 vipSign 之前（先给昨天出终态，再打今天的卡），晚批三项同理。
 * 这条顺序由 tests/orchestration.test.mjs 的整串名单断言钉住，改动顺序要一并改断言并说明理由。
 */
const TASKS = [
    { key: "dailyTask", batch: "morning", run: signDailyTask },
    { key: "yunbeiSign", batch: "morning", run: signYunbei },
    { key: "yunbeiStage", batch: "morning", run: claimYunbeiStages },
    { key: "vipSignFinal", batch: "morning", run: finalizeVipSign },
    { key: "vipSign", batch: "morning", run: signVipMusic },
    { key: "vipSignCheck", batch: "night", run: verifyVipSign },
    { key: "yunbeiTask", batch: "night", run: claimYunbeiTasks },
    { key: "vipGrowth", batch: "night", run: claimVipGrowth }
];

function shouldRunNight(now, doneOn) {
    if (now.getHours() < VIP_CLAIM_HOUR) return false;
    const today = localDate(now);
    return TASKS.filter((item) => item.batch === "night").some((item) => doneOn[item.key] !== today);
}

/**
 * Task Executors
 */
function executeSuccessTask() {
    // Only silent mode for success
    chrome.tabs.create({ url: TARGET_URL, active: false }, (tab) => {
        if (chromeFailed("tabs.create", { purpose: "会话刷新" }) || !tab) return;
        const tabId = tab.id;
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.remove(tabId, () => {
                // 关不掉也要说实话：lastError 被丢弃时日志照样写 "tab closed" 是假成功。
                if (chromeFailed("tabs.remove", { tabId })) return;
                logInfo("Silent task completed and tab closed");
            });
        };
        // 没有 tabs 权限时 onUpdated.status 只对命中 host_permissions 的标签页可见：页面被重定向出白名单，
        // complete 就永远不到，这个标签页会一直悬着。兜底定时器保证它一定被关掉。
        const timer = setTimeout(close, TAB_CLOSE_FALLBACK_MS);
        const listener = (id, info) => {
            if (id === tabId && info.status === 'complete') setTimeout(close, BUFFER_TIME_MS);
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function executeLoginTask() {
    // Opens the login page in the background and keeps it open
    chrome.tabs.create({ url: TARGET_URL, active: false }, (tab) => {
        if (chromeFailed("tabs.create", { purpose: "登录页" }) || !tab) return;
        logWarn("Login page opened in background", { tabId: tab.id });
    });
}

function showLoginNotification() {
    chrome.notifications.create(LOGIN_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: ICONS_RED["128"],
        title: 'NetEaseMusicActivator',
        message: '请登录您的账号完成签到。Login required.',
        priority: 2
    }, () => {
        if (chromeFailed("notifications.create", { id: LOGIN_NOTIFICATION_ID })) return;
        logInfo("登录提醒已发出");
    });
}

/**
 * Main Orchestrator
 */
async function runBatch(batch, doneOn) {
    const settled = [];
    let loginRequired = false;

    for (const task of TASKS.filter((item) => item.batch === batch)) {
        // 日期归属按「写出结论的那一刻」现取：整批共用一个 today 时，23:59:5x 触发的那次会把晚批和门都记到前一日。
        const today = localDate(new Date());
        if (doneOn[task.key] === today) continue;

        let result;
        try {
            result = await task.run();
        } catch (err) {
            // 网络或解析失败按瞬态处理：不写日期门，留给当天下一次触发或明天重试。
            // 栈首行必须带上 —— 任务内部缺陷也从这里出去，只写「请求异常」会让 bug 永远伪装成网络抖动。
            logError(`${task.key} 本轮失败（按瞬态重试）`, { reason: normalizeError(err), stack: firstStackLine(err) });
            continue;
        }

        if (result.needLogin) {
            logWarn(result.message);
            loginRequired = true;
            break;
        }

        if (result.done) {
            doneOn[task.key] = today;
            if (await storageSet({ [TASK_STATE_KEY]: doneOn })) {
                settled.push(task.key);
            } else {
                // 内存有门、盘上没门 ⇒ 本轮不能把它当已完成，否则同一天会把已经成功的接口重打一遍。
                delete doneOn[task.key];
            }
        }

        logInfo(result.message, result.details);
    }

    return { settled, loginRequired };
}

async function runAllBatches() {
    const stored = await storageGet(["isEnabled", TASK_STATE_KEY]);
    if (!stored) {
        // 读不到状态就无从判断哪些任务当天已经完成过，这时跑批等于把全部接口重打一遍 ⇒ 本轮直接放弃。
        logWarn("本地状态读取失败，本轮不跑批");
        scheduleNextRun();
        scheduleVipClaim(false);
        return;
    }
    const isEnabled = stored.isEnabled !== false;
    updateUI(isEnabled);

    if (!isEnabled) {
        logInfo("NetEaseMusicActivator is OFF. Skipping");
        return;
    }

    const now = new Date();
    const doneOn = { ...(stored[TASK_STATE_KEY] || {}) };

    if (!(await getCookie("MUSIC_U"))) {
        executeLoginTask();
        showLoginNotification();
        scheduleNextRun();
        scheduleVipClaim(false);
        return;
    }

    const morning = await runBatch("morning", doneOn);
    // 未登录时晚批只会同样被拒（还会把「未登录」再报一遍）⇒ 跳过；晚批日期门保持缺失，登录后下次触发补齐。
    const night = morning.loginRequired || !shouldRunNight(now, doneOn)
        ? { settled: [], loginRequired: false }
        : await runBatch("night", doneOn);

    if (morning.loginRequired || night.loginRequired) {
        executeLoginTask();
        showLoginNotification();
    } else if (morning.settled.length > 0) {
        // 只在签到批有任务真正拿到终态并落了门时开后台标签页顺带刷新会话；晚间批保持完全静默，不打扰正在浏览的窗口。
        executeSuccessTask();
    }

    // 晚批还有缺门的任务（瞬态失败或接口拒绝）⇒ 当晚窗口内再排一次；登录问题不重排，避免反复弹提醒。
    scheduleNextRun();
    scheduleVipClaim(shouldRunNight(new Date(), doneOn) && !morning.loginRequired && !night.loginRequired);
}

// onStartup、onInstalled 和一条迟到的 alarm 会在同一个 service worker 实例里并发触发，
// 两边都可能在对方写日期门之前读到旧状态，于是同一个接口当天被打两次。
let batchInFlight = null;
let rerunRequested = false;

function checkAndRun() {
    if (batchInFlight) {
        rerunRequested = true;
        return batchInFlight;
    }

    batchInFlight = (async () => {
        do {
            rerunRequested = false;
            await runAllBatches();
        } while (rerunRequested);
    })().finally(() => { batchInFlight = null; });

    return batchInFlight;
}

/**
 * Event Listeners
 */

// Toggle Switch on Click
chrome.action.onClicked.addListener(async () => {
    const stored = await storageGet(["isEnabled"]);
    if (!stored) return;
    const newState = stored.isEnabled === false;
    if (!await storageSet({ isEnabled: newState })) return;
    updateUI(newState);
    if (newState) checkAndRun();
});

// 只认这两个闹钟名：别的名字（历史版本残留、别的扩展占同一个 SW）不得触发跑批。
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME || alarm.name === ALARM_VIP_CLAIM) checkAndRun();
});

chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId !== LOGIN_NOTIFICATION_ID) return;
    // Find existing tab with music.163.com
    chrome.tabs.query({ url: "*://music.163.com/*" }, (tabs) => {
        if (chromeFailed("tabs.query", { url: "*://music.163.com/*" })) return;
        if (tabs && tabs.length > 0) {
            const tab = tabs[0];
            chrome.tabs.update(tab.id, { active: true }, () => chromeFailed("tabs.update", { tabId: tab.id }));
            chrome.windows.update(tab.windowId, { focused: true }, () => chromeFailed("windows.update", { windowId: tab.windowId }));
        } else {
            chrome.tabs.create({ url: TARGET_URL }, () => chromeFailed("tabs.create", { purpose: "登录页点击" }));
        }
    });
    chrome.notifications.clear(notificationId, () => chromeFailed("notifications.clear", { notificationId }));
});

chrome.runtime.onStartup.addListener(checkAndRun);
chrome.runtime.onInstalled.addListener(checkAndRun);

pruneLogs(() => {
    logInfo("Service worker initialized");
    ensureAlarms();
});
