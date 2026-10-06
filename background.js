importScripts("weapi.js");

const TARGET_URL = "https://music.163.com/";
const BUFFER_TIME_MS = 2000;
const ALARM_NAME = "smartDailyNetEaseCheck";
// 晚间批共用这一个闹钟：乐签复核补打 + 云贝任务奖励领取 + 成长值领取（21:00–23:59 硬窗口）。
const ALARM_VIP_CLAIM = "netEaseVipGrowthClaim";
const LOGIN_NOTIFICATION_ID = "netease_login_needed";
const LOG_STORAGE_KEY = "runtimeLogs";
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_MAX_ENTRIES = 2000;

const MUSIC_HOST = "music.163.com";
const INTERFACE_HOST = "interface.music.163.com";
const VIP_CENTER_HOST = "interface3.music.163.com";

// 乐签的签到日边界晚于凌晨；云贝任务奖励与成长值都要等白天攒进度，所以这些动作固定在本地时间 21:00 之后。
const VIP_CLAIM_HOUR = 21;
const TASK_STATE_KEY = "taskDoneOn";
const VIP_GROWTH_LOG_KEY = "vipGrowthLog";
const VIP_GROWTH_LOG_MAX = 60;

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

function enqueuePersistentLog(level, message, details) {
    const entry = {
        ts: Date.now(),
        level,
        message,
        details: details ?? null
    };

    logWriteQueue = logWriteQueue
        .then(() => new Promise((resolve) => {
            chrome.storage.local.get([LOG_STORAGE_KEY], (res) => {
                const rawLogs = Array.isArray(res[LOG_STORAGE_KEY]) ? res[LOG_STORAGE_KEY] : [];
                const cutoff = Date.now() - LOG_RETENTION_MS;
                const recentLogs = rawLogs.filter((item) => item && typeof item.ts === "number" && item.ts >= cutoff);
                recentLogs.push(entry);
                if (recentLogs.length > LOG_MAX_ENTRIES) {
                    recentLogs.splice(0, recentLogs.length - LOG_MAX_ENTRIES);
                }

                chrome.storage.local.set({ [LOG_STORAGE_KEY]: recentLogs }, () => resolve());
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
        const rawLogs = Array.isArray(res[LOG_STORAGE_KEY]) ? res[LOG_STORAGE_KEY] : [];
        const cutoff = Date.now() - LOG_RETENTION_MS;
        const recentLogs = rawLogs.filter((item) => item && typeof item.ts === "number" && item.ts >= cutoff);
        chrome.storage.local.set({ [LOG_STORAGE_KEY]: recentLogs }, () => {
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
 */
function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res || {})));
}

function storageSet(entries) {
    return new Promise((resolve) => chrome.storage.local.set(entries, () => resolve()));
}

function getCookie(name) {
    return new Promise((resolve) => {
        chrome.cookies.get({ url: TARGET_URL, name }, (cookie) => resolve(cookie ? cookie.value : ""));
    });
}

function localDate(date) {
    return date.toDateString();
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
    if (isEnabled) {
        chrome.action.setIcon({ path: ICONS_RED });
        chrome.action.setTitle({ title: "NetEaseMusicActivator: Active" });
    } else {
        chrome.action.setIcon({ path: ICONS_GRAY });
        chrome.action.setTitle({ title: "NetEaseMusicActivator: Disabled (Click to enable)" });
    }
}

/**
 * Schedule next run at 00:00:05 of the next day
 */
function scheduleNextRun() {
    const nextRun = new Date();
    nextRun.setHours(24, 0, 5, 0);
    chrome.alarms.create(ALARM_NAME, { when: nextRun.getTime() });
    logInfo("Next check scheduled at", nextRun.toLocaleString());
}

/**
 * Schedule the evening batch (sign verify / yunbei tasks / growth claim) for the next 21:00 local
 */
function scheduleVipClaim() {
    const nextRun = new Date();
    nextRun.setHours(nextRun.getHours() >= VIP_CLAIM_HOUR ? 24 + VIP_CLAIM_HOUR : VIP_CLAIM_HOUR, 0, 0, 0);
    chrome.alarms.create(ALARM_VIP_CLAIM, { when: nextRun.getTime() });
    logInfo("Next evening batch scheduled at", nextRun.toLocaleString());
}

/**
 * API Check-in Logic
 * 每个任务返回 { done, needLogin, message, details }：
 * done=true 才写当天日期门；needLogin=true 会中止整批并触发登录提醒。
 */
const NOT_LOGGED_IN = 301;

function notLoggedIn(code, label) {
    return code === NOT_LOGGED_IN ? { done: false, needLogin: true, message: `${label}：未登录` } : null;
}

function rejected(code, label) {
    return { done: true, message: `${label}：接口拒绝`, details: { code } };
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

async function signVipMusic() {
    const data = await weapiRequest(VIP_CENTER_HOST, "/weapi/vip-center-bff/task/sign", {}, await getCookie("__csrf"));
    if (data.code !== 200) return notLoggedIn(data.code, "乐签") || rejected(data.code, "乐签");
    // 凌晨打卡可能落到前一天（乐签签到日边界晚于 00:00），这里只表示请求被受理，终态看晚间复核。
    if (data.data === true) return { done: true, message: "乐签：打卡请求成功" };

    return { done: true, message: "乐签：本次未完成", details: { reason: data.message || data.msg || "" } };
}

async function verifyVipSign() {
    const csrfToken = await getCookie("__csrf");
    const info = await weapiRequest(VIP_CENTER_HOST, "/weapi/vipnewcenter/app/user/sign/info", {}, csrfToken);
    if (info.code !== 200) return notLoggedIn(info.code, "乐签复核") || rejected(info.code, "乐签复核");

    const rows = Array.isArray(info.data) ? info.data : [];
    if (rows.some((row) => row && row.today === true)) {
        return { done: true, message: "乐签复核：今日已签" };
    }

    const punch = await weapiRequest(VIP_CENTER_HOST, "/weapi/vip-center-bff/task/sign", {}, csrfToken);
    if (punch.code !== 200) return notLoggedIn(punch.code, "乐签补打") || rejected(punch.code, "乐签补打");

    return punch.data === true
        ? { done: true, message: "乐签复核：凌晨打卡未生效，已补打成功" }
        : { done: true, message: "乐签复核：补打未完成", details: { reason: punch.message || punch.msg || "" } };
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

    // getall 的响应里没有金额，所以非 200 时只多读一次基础信息用于解释原因，不做循环重试。
    const detail = await weapiRequest(MUSIC_HOST, "/weapi/vipnewcenter/app/level/growhpoint/basic", {}, csrfToken)
        .catch(() => null);
    const level = detail && detail.data && detail.data.userLevel;

    return {
        done: true,
        message: "VIP 成长值：未领取",
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
    const log = Array.isArray(stored[VIP_GROWTH_LOG_KEY]) ? stored[VIP_GROWTH_LOG_KEY] : [];
    const now = new Date();

    log.push({ d: localDate(now), ts: now.getTime(), ok: true });
    if (log.length > VIP_GROWTH_LOG_MAX) log.splice(0, log.length - VIP_GROWTH_LOG_MAX);
    await storageSet({ [VIP_GROWTH_LOG_KEY]: log });
}

/**
 * Task Registry
 */
const TASKS = [
    { key: "dailyTask", batch: "morning", run: signDailyTask },
    { key: "yunbeiSign", batch: "morning", run: signYunbei },
    { key: "yunbeiStage", batch: "morning", run: claimYunbeiStages },
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
        const tabId = tab.id;
        const listener = (id, info) => {
            if (id === tabId && info.status === 'complete') {
                setTimeout(() => {
                    chrome.tabs.remove(id, () => chrome.runtime.lastError);
                    logInfo("Silent task completed and tab closed");
                }, BUFFER_TIME_MS);
                chrome.tabs.onUpdated.removeListener(listener);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function executeLoginTask() {
    // Opens the login page in the background and keeps it open
    chrome.tabs.create({ url: TARGET_URL, active: false }, (tab) => {
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
    });
}

/**
 * Main Orchestrator
 */
async function runBatch(batch, doneOn, today) {
    let ran = 0;
    let loginRequired = false;

    for (const task of TASKS.filter((item) => item.batch === batch)) {
        if (doneOn[task.key] === today) continue;

        let result;
        try {
            result = await task.run();
        } catch (err) {
            // 网络或解析失败按瞬态处理：不写日期门，留给当天下一次触发或明天重试。
            logError(`${task.key} 请求异常`, normalizeError(err));
            continue;
        }

        if (result.needLogin) {
            logWarn(result.message);
            loginRequired = true;
            break;
        }

        if (result.done) {
            doneOn[task.key] = today;
            await storageSet({ [TASK_STATE_KEY]: doneOn });
        }

        logInfo(result.message, result.details);
        ran++;
    }

    return { ran, loginRequired };
}

async function runAllBatches() {
    const stored = await storageGet(["isEnabled", TASK_STATE_KEY]);
    const isEnabled = stored.isEnabled !== false;
    updateUI(isEnabled);

    if (!isEnabled) {
        logInfo("NetEaseMusicActivator is OFF. Skipping");
        return;
    }

    const now = new Date();
    const today = localDate(now);
    const doneOn = { ...(stored[TASK_STATE_KEY] || {}) };

    if (!(await getCookie("MUSIC_U"))) {
        executeLoginTask();
        showLoginNotification();
        scheduleNextRun();
        scheduleVipClaim();
        return;
    }

    const morning = await runBatch("morning", doneOn, today);
    const night = shouldRunNight(now, doneOn) ? await runBatch("night", doneOn, today) : { ran: 0, loginRequired: false };

    if (morning.loginRequired || night.loginRequired) {
        executeLoginTask();
        showLoginNotification();
    } else if (morning.ran > 0) {
        // 只在签到批成功后开后台标签页顺带刷新会话；晚间批保持完全静默，不打扰正在浏览的窗口。
        executeSuccessTask();
    }

    scheduleNextRun();
    scheduleVipClaim();
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
chrome.action.onClicked.addListener(() => {
    chrome.storage.local.get(['isEnabled'], (res) => {
        const newState = res.isEnabled === false;
        chrome.storage.local.set({ isEnabled: newState }, () => {
            updateUI(newState);
            if (newState) checkAndRun();
        });
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME || alarm.name === ALARM_VIP_CLAIM) checkAndRun();
});

chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId === LOGIN_NOTIFICATION_ID) {
        // Find existing tab with music.163.com
        chrome.tabs.query({ url: "*://music.163.com/*" }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const tab = tabs[0];
                chrome.tabs.update(tab.id, { active: true });
                chrome.windows.update(tab.windowId, { focused: true });
            } else {
                 chrome.tabs.create({ url: TARGET_URL });
            }
        });
        chrome.notifications.clear(notificationId);
    }
});

chrome.runtime.onStartup.addListener(checkAndRun);
chrome.runtime.onInstalled.addListener(checkAndRun);

pruneLogs(() => {
    logInfo("Service worker initialized");
});
