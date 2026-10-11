// 调度与门控的行为测试：在独立 vm 上下文里加载扩展真身，用 chrome/fetch 桩件离线跑
// checkAndRun，验证「21:00 硬窗口、每天最多一次、瞬态失败与接口拒绝都不写门、乐签只在成长值流水缺条目时补打」
// 这些约束真的生效。
// 上下文必须独立于宿主 realm：伪造 Date 泄漏到宿主会污染测试进程自身的序列化。
// 跑法：node --test（在仓库根目录运行；带目录参数的 node --test tests/ 在 Node 25 下会报 MODULE_NOT_FOUND）
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const OK_SIGN = { re: /api\/point\/dailyTask/, body: { code: 200, point: 2 } };
const OK_YUNBEI = { re: /weapi\/pointmall\/user\/sign\?/, body: { code: 200, data: { sign: true } } };
const NO_STAGE = { re: /weapi\/pointmall\/user\/sign\/config\?/, body: { code: 200, data: { lotteryConfig: [] } } };
const OK_PUNCH = { re: /weapi\/vip-center-bff\/task\/sign/, body: { code: 200, data: true, message: "" } };
const OK_CLAIM = { re: /task\/reward\/getall/, body: { code: 200, data: { result: true } } };
const OK_TODO = {
    re: /usertool\/task\/todo\/query/,
    body: {
        code: 200,
        data: [
            { completed: true, period: 1, userTaskId: 11, depositCode: 1304, taskPoint: 300, taskName: "听漫游(桩)" },
            { completed: false, period: 2, userTaskId: 22, depositCode: 1305, taskPoint: 8, taskName: "看视频(桩)" }
        ]
    }
};
const OK_RECEIVE = { re: /usertool\/task\/point\/receive/, body: { code: 200, data: true } };

// 乐签计入的唯一判据 = 成长值流水里当天那条「黑胶乐签每日打卡」(+3)。sign/info 的 recordId 属于另一条
// 更慢、且会整段不出的唱片记录行流水线（10-09 流水已计 +3、recordId 到 +41h 仍为 0），不再读它。
// 冻结的时钟是 2026-10-05，所以"今天"= 2026-10-05，晨批终态核对的"昨天"= 2026-10-04。
// 日界必须按本地时区构造，与 background.js 的 dayBounds 同源（宿主与 vm 同一时区，显式传参不吃冻结时钟）。
const DAY_START = new Date(2026, 9, 5).getTime();
const PREV_DAY_START = new Date(2026, 9, 4).getTime();
const PREV2_DAY_START = new Date(2026, 9, 3).getTime();
const PREV3_DAY_START = new Date(2026, 9, 2).getTime();
const LEDGER_RE = /weapi\/vipnewcenter\/app\/level\/growth\/details\?/;
const MUSIC_SIGN = (time) => ({ descript: "黑胶乐签每日打卡", growthPoint: 3, time, resourceId: 0 });
const SVIP_GRANT = (time) => ({ descript: "黑胶SVIP每日发放", growthPoint: 20, time, resourceId: 0 });
// 10-11 00:34:09.779 真机出现过：与打卡条目同秒、含「乐签」二字，但它不是每日打卡，不得计入。
const LADDER_PRIZE = (time) => ({ descript: "黑胶乐签阶梯奖励 +30", growthPoint: 30, time, resourceId: 0 });

const ledger = (details, hasMore = false) => ({
    re: LEDGER_RE,
    body: { code: 200, message: "success", data: { hasMore, details } }
});
// 今天与昨天都已计入，另掺一条"昨天 23:00 的 SVIP 发放"：它落在昨天的日界内但不是乐签，必须不算数。
const LEDGER_COUNTED = ledger([
    MUSIC_SIGN(DAY_START + 4900),
    SVIP_GRANT(DAY_START - 3600000),
    MUSIC_SIGN(PREV_DAY_START + 4300),
    { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: PREV2_DAY_START + 90000, resourceId: 0 }
]);
// 昨天被覆盖到（翻到了尽头）却没有乐签条目 → 真没计入。
const LEDGER_MISS_YESTERDAY = ledger([
    MUSIC_SIGN(DAY_START + 4900),
    SVIP_GRANT(PREV_DAY_START + 500000),
    SVIP_GRANT(PREV2_DAY_START + 500000)
]);
// hasMore 恒为 true，且全部条目晚于"昨天"的日界：既没翻到尽头、也没有条目越过目标日 ⇒ 证据不足，只能"无法判定"。
const LEDGER_NOT_COVERED = ledger([
    SVIP_GRANT(DAY_START + 3600000),
    { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: DAY_START + 7200000, resourceId: 0 }
], true);
// 只有更早的行、且仍在翻页：旧实现把「采样里有更早的行」当覆盖证明，会说成"未计入"（假阴性）。
const LEDGER_OLDER_ONLY = ledger([
    SVIP_GRANT(PREV2_DAY_START + 500000),
    MUSIC_SIGN(PREV3_DAY_START + 500000)
], true);
// 昨天有、今天没有：晚批（本轮没打过卡时）必须补打一次。
const LEDGER_NO_TODAY = ledger([
    MUSIC_SIGN(PREV_DAY_START + 4300),
    SVIP_GRANT(PREV2_DAY_START + 500000)
]);
// 今天只有非乐签条目 + 已翻到尽头：今天判 false（可以补打），昨天同样判 false。
const LEDGER_ONLY_TODAY_NOISE = ledger([
    SVIP_GRANT(DAY_START + 3600000),
    { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: DAY_START + 7200000, resourceId: 0 }
]);
// 今天只有「黑胶乐签阶梯奖励 +30」：含「乐签」二字，但它是节点奖，不是每日打卡条目。
const LEDGER_LADDER_PRIZE_TODAY = ledger([
    LADDER_PRIZE(DAY_START + 500),
    SVIP_GRANT(PREV2_DAY_START + 500000)
]);
// 翻页桩件：limit/offset 在 POST body 里，fetch 桩件只看得到 URL，所以按调用序号发页。
function ledgerPages(bodies) {
    let n = 0;
    return { re: LEDGER_RE, body: () => bodies[Math.min(n++, bodies.length - 1)] };
}
const ALL_OK = [OK_SIGN, OK_YUNBEI, NO_STAGE, LEDGER_COUNTED, OK_PUNCH, OK_TODO, OK_RECEIVE, OK_CLAIM];

const TODAY = "Mon Oct 05 2026";
const YESTERDAY = "Sun Oct 04 2026";
// 只认这两个闹钟名，别的名字（历史残留）不得触发跑批。
const ALARM_MORNING = "smartDailyNetEaseCheck";
const ALARM_NIGHT = "netEaseVipGrowthClaim";
const MORNING_KEYS = ["dailyTask", "yunbeiSign", "yunbeiStage", "vipSignFinal", "vipSign"];
const NIGHT_KEYS = ["vipSignCheck", "yunbeiTask", "vipGrowth"];
const MORNING_DONE = Object.fromEntries(MORNING_KEYS.map((key) => [key, TODAY]));
const NIGHT_DONE = Object.fromEntries(NIGHT_KEYS.map((key) => [key, TODAY]));
const ALL_DONE = { ...MORNING_DONE, ...NIGHT_DONE };
// 凭据一律用可 grep 的占位串：防回归断言要检查它们没有落进 store 或日志。
const MUSIC_U_VALUE = "MU_PLACEHOLDER_DO_NOTLEAK";
const CSRF_VALUE = "CSRF_PLACEHOLDER_DO_NOTLEAK";

function makeChrome(state) {
    // 真实 chrome 的语义：lastError 是个 Error，只在回调期间可读，回调返回后清空。
    const invoke = (callback, error, ...args) => {
        if (typeof callback !== "function") return;
        state.lastError = error == null ? null : (error instanceof Error ? error : new Error(String(error)));
        try {
            callback(...args);
        } finally {
            state.lastError = null;
        }
    };
    const failure = (op) => (state.failOps ?? []).includes(op) ? `桩件注入失败: ${op}` : null;
    const event = (sink) => ({
        addListener: (fn) => sink.push(fn),
        removeListener: (fn) => {
            const i = sink.indexOf(fn);
            if (i >= 0) sink.splice(i, 1);
        }
    });

    return {
        storage: {
            local: {
                get(keys, callback) {
                    const err = state.failGet && state.failGet(keys) ? `桩件注入失败: storage.local.get ${keys}` : null;
                    if (err) return invoke(callback, err, {});
                    const wanted = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(state.store));
                    const result = {};
                    for (const key of wanted) if (key in state.store) result[key] = structuredClone(state.store[key]);
                    invoke(callback, null, result);
                },
                set(entries, callback) {
                    const err = state.failSet && state.failSet(entries) ? `桩件注入失败: storage.local.set ${Object.keys(entries)}` : null;
                    if (!err) for (const [key, value] of Object.entries(entries)) state.store[key] = structuredClone(value);
                    invoke(callback, err);
                },
            },
        },
        cookies: {
            get(query, callback) {
                const value = state.cookies[query.name];
                invoke(callback, failure("cookies.get"), value ? { value } : null);
            },
        },
        alarms: {
            create: (name, info, callback) => {
                state.alarms.push({ name, info });
                invoke(callback, failure("alarms.create"));
            },
            get: (name, callback) => {
                const last = state.alarms.filter((a) => a.name === name).pop();
                invoke(callback, failure("alarms.get"), last ? { name, ...last.info } : undefined);
            },
            onAlarm: event(state.alarmListeners),
        },
        action: {
            setIcon: (details, callback) => invoke(callback, failure("action.setIcon")),
            setTitle: (details, callback) => invoke(callback, failure("action.setTitle")),
            onClicked: event(state.actionClickListeners),
        },
        notifications: {
            create: (id, options, callback) => {
                state.notifications.push(id);
                invoke(callback, failure("notifications.create"));
            },
            clear: (id, callback) => {
                state.cleared.push(id);
                invoke(callback, failure("notifications.clear"));
            },
            onClicked: event(state.notificationClickListeners),
        },
        tabs: {
            create: (options, callback) => {
                state.tabs.push(options.url);
                invoke(callback, failure("tabs.create"), { id: state.tabs.length });
            },
            remove: (id, callback) => {
                state.removed.push(id);
                invoke(callback, failure("tabs.remove"));
            },
            query: (query, callback) => invoke(callback, failure("tabs.query"), state.queryResult),
            update: (id, options, callback) => {
                state.tabUpdates.push(id);
                invoke(callback, failure("tabs.update"));
            },
            onUpdated: event(state.tabUpdatedListeners),
        },
        windows: {
            update: (id, options, callback) => {
                state.windowUpdates.push(id);
                invoke(callback, failure("windows.update"));
            },
        },
        runtime: {
            onStartup: event(state.startupListeners),
            onInstalled: event(state.installedListeners),
            get lastError() { return state.lastError; },
        },
    };
}

// 只固定「现在」，其余 Date 行为保持原样，这样 background.js 里的 new Date()/toDateString() 都可控。
// 必须在上下文内部改写它自己的 Date，跨 realm 注入会牵连测试进程的序列化。
function freezeClock(context, hour) {
    const fixed = new Date(2026, 9, 5, hour, 30, 0).getTime();
    vm.runInContext(`
        (() => {
            const RealDate = Date;
            const fixed = ${fixed};
            class FrozenDate extends RealDate {
                constructor(...args) { super(...(args.length ? args : [fixed])); }
                static now() { return fixed; }
            }
            globalThis.Date = FrozenDate;
        })()
    `, context, { filename: "frozen-clock.js" });
}

async function harness({ hour = 9, routes = [], cookies = { MUSIC_U: MUSIC_U_VALUE, __csrf: CSRF_VALUE }, store = {}, failOnce, failOps, failGet, failSet, existingAlarms = [] } = {}) {
    const state = {
        store,
        cookies,
        alarms: existingAlarms.map((a) => ({ ...a })),
        notifications: [],
        tabs: [],
        removed: [],
        cleared: [],
        tabUpdates: [],
        windowUpdates: [],
        queryResult: [],
        timers: [],
        alarmListeners: [],
        actionClickListeners: [],
        notificationClickListeners: [],
        tabUpdatedListeners: [],
        startupListeners: [],
        installedListeners: [],
        failOps,
        failGet,
        failSet,
        lastError: null,
    };
    const calls = [];
    const alreadyFailed = new Set();
    const silentConsole = { log() {}, warn() {}, error() {}, group() {}, groupEnd() {}, table() {} };

    const fetchStub = async (url) => {
        const target = String(url);
        calls.push(target);
        if (failOnce && failOnce.test(target) && !alreadyFailed.has(target)) {
            alreadyFailed.add(target);
            throw new TypeError("offline");
        }
        const matched = routes.find((route) => route.re.test(target));
        if (!matched) throw new Error(`测试未桩件化该请求: ${target}`);
        const body = typeof matched.body === "function" ? matched.body(target) : matched.body;
        return { ok: true, status: 200, json: async () => body };
    };

    const context = vm.createContext({
        chrome: makeChrome(state),
        fetch: fetchStub,
        console: silentConsole,
        crypto: globalThis.crypto,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        structuredClone,
        // 标签页自关的定时器不能在测试里真的等 2s/30s，记录下来让用例自己拨。
        setTimeout: (fn, ms) => {
            state.timers.push({ fn, ms });
            return state.timers.length;
        },
        clearTimeout: () => {},
        queueMicrotask,
        btoa,
        atob,
    });
    freezeClock(context, hour);

    const sources = {};
    for (const file of ["weapi.js", "background.js"]) {
        sources[file] = await readFile(path.join(ROOT, file), "utf8");
    }
    // 真实加载路径：background.js 顶层 importScripts('weapi.js')，两个文件共享同一全局词法作用域。
    context.importScripts = (...files) => {
        for (const file of files) vm.runInContext(sources[file], context, { filename: file });
    };
    vm.runInContext(sources["background.js"], context, { filename: "background.js" });

    const drain = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
    // SW 顶层的 ensureAlarms 会在加载时对账一次，把这段排程与跑批期间的排程分开，别让用例互相污染。
    const initAlarms = state.alarms.splice(existingAlarms.length);

    return {
        state,
        calls,
        initAlarms,
        messages: () => (state.store.runtimeLogs || []).map((entry) => entry.message),
        logs: () => state.store.runtimeLogs || [],
        async run() {
            await vm.runInContext("checkAndRun()", context);
            await drain();
        },
        async runConcurrently(times) {
            await vm.runInContext(`Promise.all([${Array(times).fill("checkAndRun()").join(", ")}])`, context);
            await drain();
        },
        async fireAlarm(name) {
            for (const fn of state.alarmListeners) fn({ name });
            for (let i = 0; i < 400 && await vm.runInContext("batchInFlight", context); i++) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            await drain();
        },
        async fireNotificationClick(id) {
            for (const fn of state.notificationClickListeners) fn(id);
            await drain();
        },
        fireTabUpdated(id, info) {
            for (const fn of state.tabUpdatedListeners) fn(id, info);
        },
        // 拨动登记过的定时器（complete 之后的 2s、兜底的 30s），不依赖真实时钟。
        async fireTimer(ms) {
            const timer = state.timers.find((t) => t.ms === ms);
            assert.ok(timer, `没有登记过 ${ms}ms 的定时器`);
            timer.fn();
            await drain();
        },
        evaluate(script) {
            return vm.runInContext(script, context);
        },
    };
}

const punched = (h) => h.calls.filter((url) => /weapi\/vip-center-bff\/task\/sign/.test(url)).length;
const ledgerReads = (h) => h.calls.filter((url) => /app\/level\/growth\/details/.test(url)).length;
const lastAlarm = (h, name) => h.state.alarms.filter((a) => a.name === name).pop();

test("并发触发（onStartup + onInstalled + 迟到的 alarm 同时到）每个接口只打一次", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.runConcurrently(3);

    // 成长值流水是只读核对，晨批核昨日 + 晚批核今日各读一次；其余（含打卡）全天各一次。
    const expectedHits = {
        "/api/point/dailyTask": 1,
        "/weapi/pointmall/user/sign?": 1,
        "/weapi/pointmall/user/sign/config?": 1,
        "/weapi/vip-center-bff/task/sign": 1,
        "/weapi/vipnewcenter/app/level/growth/details?": 2,
        "/weapi/usertool/task/todo/query": 1,
        "/weapi/usertool/task/point/receive": 1,
        "/weapi/vipnewcenter/app/level/task/reward/getall": 1
    };
    for (const [endpoint, times] of Object.entries(expectedHits)) {
        const hits = h.calls.filter((url) => url.includes(endpoint));
        assert.equal(hits.length, times, `${endpoint} 被打了几次：${hits.length}，期望 ${times}`);
    }
    assert.equal(h.state.store.vipGrowthLog.length, 1, "并发触发不得写出两条当日账目");
    assert.equal(h.state.store.taskDoneOn.vipSignCheck, TODAY);
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY);
    assert.equal(h.state.store.taskDoneOn.vipGrowth, TODAY);
});

test("窗口外（09:30）只跑签到批，绝不触碰成长值接口", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK });
    await h.run();
    const GROWTH_READ = (url) => /weapi\/vipnewcenter\/app\/level\/growth\/details/.test(url);

    assert.equal(h.calls.length, 5, `期望 5 次请求，实际 ${h.calls.length}`);
    assert.ok(h.calls.every((url) => !/reward\/getall/.test(url)), "窗口外不应调用 getall");
    assert.ok(h.calls.every((url) => !/usertool\//.test(url)), "窗口外不应触碰晚间批接口");
    assert.equal(punched(h), 1, "晨批照常打卡");
    assert.equal(ledgerReads(h), 1, "晨批只读一次流水核对昨日终态（命中即返回，不再多读一页）");
    assert.deepEqual(h.state.store.taskDoneOn, MORNING_DONE);
    assert.ok(!("vipGrowth" in h.state.store.taskDoneOn), "窗口外不应写入 vipGrowth 日期门");
});

test("窗口内（21:30）跑完整晚批，并落下本地账目", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    assert.equal(h.calls.filter((url) => /reward\/getall/.test(url)).length, 1, "getall 应恰好调用一次");
    assert.equal(ledgerReads(h), 2, "晨批核昨日 + 晚批复核今日");
    assert.equal(h.calls.filter((url) => /task\/point\/receive/.test(url)).length, 1, "completed 的条目逐个领取");
    assert.equal(punched(h), 1, "今日流水已有乐签条目时不得补打，打卡请求全天只有晨批那一次");
    assert.equal(h.state.store.taskDoneOn.vipSignCheck, TODAY);
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY);
    assert.equal(h.state.store.taskDoneOn.vipGrowth, TODAY);
    assert.equal(lastAlarm(h, ALARM_NIGHT).info.when, new Date(2026, 9, 6, 21, 0, 0).getTime(),
        "晚批全部落门 ⇒ 顺延次日 21:00，当晚不再重排");

    const log = h.state.store.vipGrowthLog;
    assert.equal(log.length, 1);
    assert.deepEqual(Object.keys(log[0]).sort(), ["d", "ok", "ts"], "账目只允许 {d, ts, ok}，不得记任务名或歌曲名");
    assert.equal(log[0].ok, true);
});

test("连签阶段奖励只领待领的那一档", async () => {
    const h = await harness({
        hour: 9,
        routes: [
            OK_SIGN,
            OK_YUNBEI,
            {
                re: /weapi\/pointmall\/user\/sign\/config\?/,
                body: {
                    code: 200,
                    data: {
                        lotteryConfig: [
                            { signDay: 3, baseLotteryId: 111, baseLotteryStatus: 0 },
                            { signDay: 7, baseLotteryId: 222, baseLotteryStatus: 1 },
                            { signDay: 28, baseLotteryId: 0, baseLotteryStatus: 0 },
                        ],
                    },
                },
            },
            { re: /pointmall\/user\/sign\/lottery\/get\?/, body: { code: 200, data: true } },
            LEDGER_COUNTED,
            OK_PUNCH,
            OK_CLAIM,
        ],
    });
    await h.run();
    const lottery = h.calls.filter((url) => /sign\/lottery\/get/.test(url));
    assert.equal(lottery.length, 1, "已领过和未达到的档位都不应调用");
    assert.ok(lottery[0].startsWith("https://interface.music.163.com/"), "领奖走 interface 子域");
    assert.equal(h.state.store.taskDoneOn.yunbeiStage, TODAY);
});

test("当天已领过时，窗口内重启浏览器零请求", async () => {
    const h = await harness({ hour: 22, routes: ALL_OK, store: { taskDoneOn: ALL_DONE } });
    await h.run();
    assert.deepEqual(h.calls, [], "全部任务当天已完成时应零请求");
    assert.equal(h.state.store.vipGrowthLog, undefined, "不应重复记账");
});

test("成长值已领但复核缺门时，晚批仍会运行并只补缺失的任务", async () => {
    const h = await harness({
        hour: 22,
        routes: ALL_OK,
        store: { taskDoneOn: { ...MORNING_DONE, vipGrowth: TODAY } }
    });
    await h.run();
    assert.equal(ledgerReads(h), 1, "复核缺门应触发");
    assert.equal(h.calls.filter((url) => /usertool\/task\/todo\/query/.test(url)).length, 1, "云贝任务缺门应触发");
    assert.equal(h.calls.filter((url) => /reward\/getall/.test(url)).length, 0, "已领过的成长值不重复请求");
    assert.equal(h.state.store.taskDoneOn.vipSignCheck, TODAY);
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY);
});

test("同一天重复触发被日期门挡住，各任务整天最多一次网络调用", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    const first = h.calls.length;
    await h.run();
    assert.equal(h.calls.length, first, "重复触发不应产生新请求");
    assert.equal(h.calls.filter((url) => /reward\/getall/.test(url)).length, 1);
});

test("无 MUSIC_U 时零请求，只提醒登录，并且提醒确实落了门日志", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK, cookies: { __csrf: CSRF_VALUE } });
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.state.notifications, ["netease_login_needed"]);
    assert.equal(h.state.store.taskDoneOn, undefined, "未登录不得写任何日期门");
    assert.ok(h.messages().includes("登录提醒已发出"), "登录提醒的成败要写进日志，不能只在内存里假设成功");
});

test("瞬态失败不写日期门，下次触发会重试且不弹登录提醒", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK, failOnce: /weapi\/pointmall\/user\/sign\?/ });

    await h.run();
    assert.ok(!("yunbeiSign" in h.state.store.taskDoneOn), "失败的请求不应写入日期门");
    assert.ok("dailyTask" in h.state.store.taskDoneOn, "同批其它任务应照常完成");
    assert.deepEqual(h.state.notifications, [], "瞬态失败不该弹登录提醒");
    assert.ok(h.messages().some((m) => m.startsWith("yunbeiSign 本轮失败（按瞬态重试）")),
        "瞬态日志要带栈首行，任务内部缺陷才不会被当成网络抖动");

    await h.run();
    const attempts = h.calls.filter((url) => /weapi\/pointmall\/user\/sign\?/.test(url)).length;
    assert.equal(attempts, 2, "云贝签到应在下次触发时重试");
    assert.equal(h.state.store.taskDoneOn.yunbeiSign, TODAY, "重试成功后才写日期门");
});

// XDOM-H1：接口拒绝不是当天的确定结论。改回 done:true 时这三条消费点必须各自变红（真身有 8 个消费点共用这一个出口）。
test("接口拒绝（非 200 非 301）不写日期门，下次触发重试，也不弹登录提醒", async () => {
    const h = await harness({
        hour: 9,
        routes: ALL_OK.map((r) => (r === OK_YUNBEI ? { re: OK_YUNBEI.re, body: { code: -1 } } : r))
    });
    await h.run();
    assert.ok(h.messages().some((m) => m === "云贝签到：接口拒绝（本轮未落门，等下次触发重试）"),
        `实际日志：${JSON.stringify(h.messages())}`);
    assert.ok(!("yunbeiSign" in h.state.store.taskDoneOn), "拒绝码不得落当天日期门");
    assert.deepEqual(h.state.notifications, [], "拒绝不是登录问题");

    await h.run();
    assert.equal(h.calls.filter((url) => /weapi\/pointmall\/user\/sign\?/.test(url)).length, 2, "拒绝后下次触发应重试");
});

test("乐签打卡被拒不落门，当天下次触发还会再打", async () => {
    const h = await harness({
        hour: 9,
        routes: ALL_OK.map((r) => (r === OK_PUNCH ? { re: OK_PUNCH.re, body: { code: 461 } } : r))
    });
    await h.run();
    assert.ok(!("vipSign" in h.state.store.taskDoneOn), "打卡被拒不是终态");
    assert.ok(h.messages().some((m) => m === "乐签：接口拒绝（本轮未落门，等下次触发重试）"),
        `实际：${JSON.stringify(h.messages())}`);

    await h.run();
    assert.equal(punched(h), 2, "同一天两次尝试 = 拒绝后确实重试了");
    assert.ok(!("vipSign" in h.state.store.taskDoneOn), "一直失败就一直没有门");
});

// VER-M4：流水读取被拒时，复核既不能下结论，更不能把补打这个写操作发出去。
test("成长值流水被拒时复核不发补打，且两处都不落门", async () => {
    const h = await harness({
        hour: 21,
        routes: ALL_OK.map((r) => (r === LEDGER_COUNTED ? { re: LEDGER_RE, body: { code: 502 } } : r))
    });
    await h.run();
    assert.equal(punched(h), 1, "只有晨批那一次打卡；复核读不到流水时不得发出补打");
    assert.ok(!("vipSignFinal" in h.state.store.taskDoneOn), "流水被拒不落终态门");
    assert.ok(!("vipSignCheck" in h.state.store.taskDoneOn), "复核被拒不落门");
    assert.ok(h.messages().filter((m) => m === "乐签终态：接口拒绝（本轮未落门，等下次触发重试）" ||
        m === "乐签复核：接口拒绝（本轮未落门，等下次触发重试）").length === 2, `实际：${JSON.stringify(h.messages())}`);
});

test("VIP 成长值领取被拒不落门（当晚窗口内的重排才有意义）", async () => {
    const h = await harness({
        hour: 21,
        routes: ALL_OK
            .map((r) => (r === OK_CLAIM ? { re: OK_CLAIM.re, body: { code: 502 } } : r))
            .concat([{ re: /growhpoint\/basic/, body: { code: 200, data: { userLevel: { latestVipStatus: 0, maxLevel: 1 } } } }])
    });
    await h.run();
    assert.ok(!("vipGrowth" in (h.state.store.taskDoneOn || {})), "领取失败不得写门");
    const night = lastAlarm(h, ALARM_NIGHT);
    assert.equal(new Date(night.info.when).getDate(), 5, "晚批还有缺门 ⇒ 当晚 21:00–23:59 内必须还有触发机会");
    assert.ok(new Date(night.info.when).getHours() >= 21, "重排必须落在窗口内");
});

test("301 未登录时中止整批并跳过晚批，只打一次请求", async () => {
    const h = await harness({ hour: 21, routes: [{ re: /api\/point\/dailyTask/, body: { code: 301 } }, ...ALL_OK.slice(1)] });
    await h.run();
    assert.deepEqual(h.calls, ["https://music.163.com/api/point/dailyTask?type=1"],
        `未登录后不该再打任何接口，实际：${JSON.stringify(h.calls)}`);
    assert.deepEqual(h.state.notifications, ["netease_login_needed"]);
    assert.equal(h.state.store.taskDoneOn, undefined);
    assert.equal(lastAlarm(h, ALARM_NIGHT).info.when, new Date(2026, 9, 6, 21, 0, 0).getTime(),
        "登录问题不得变成当晚每 20 分钟一次的提醒风暴");
});

test("乐签晨批终态：昨日流水有条目时报已计入，且不再请求 sign/info", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK });
    await h.run();
    assert.ok(h.state.store.runtimeLogs.some((entry) => entry.message === "乐签 2026-10-04 已计入"),
        "晨批应先给昨天出终态");
    assert.equal(h.state.store.taskDoneOn.vipSignFinal, TODAY);
    assert.equal(h.calls.filter((url) => /app\/user\/sign\/info/.test(url)).length, 0,
        "唱片记录行会整段不出（10-09 即如此），读它会再造假阴性，判据不得回到 sign/info");
});

test("乐签晨批终态：流水已翻到尽头却无乐签条目时报未计入，且不为过期的一天额外打卡", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_MISS_YESTERDAY],
        store: { taskDoneOn: { vipSign: YESTERDAY } }
    });
    await h.run();
    assert.ok(h.messages().includes("乐签 2026-10-04 未计入，已过当天无法补"), `实际：${JSON.stringify(h.messages())}`);
    assert.equal(punched(h), 1, "昨天已无法补救，只能打今天这一次");
});

test("乐签晨批终态：流水没覆盖到昨日时只能声明无法判定，且不再落门", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_NOT_COVERED]
    });
    await h.run();
    const messages = h.messages();
    assert.ok(messages.some((m) => m.includes("乐签 2026-10-04 无法判定：流水未覆盖当天")), `实际：${JSON.stringify(messages)}`);
    assert.ok(!messages.some((m) => m.includes("未计入")), "证据不足不得降级成失败断言");
    assert.ok(!("vipSignFinal" in h.state.store.taskDoneOn), "证据不足不是终态，下一次触发还要再核一次");
    assert.equal(ledgerReads(h), 5, "翻页上限就是成本上限：5 页必须封顶，不能变成无限翻页");
});

// VER-M1：「采样里有更早的行」不等于「覆盖到那一天」。
test("流水只有更早的行且仍在翻页时，不得把昨天说成未计入", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_OLDER_ONLY],
        store: { taskDoneOn: { vipSign: YESTERDAY } }
    });
    await h.run();
    assert.ok(h.messages().some((m) => m.includes("乐签 2026-10-04 无法判定")),
        `目标日被翻页边界切掉时的假阴性又回来了：${JSON.stringify(h.messages())}`);
});

test("流水已翻到尽头时，全部条目晚于昨天也算覆盖 —— 判未计入而不是证据不足", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_ONLY_TODAY_NOISE],
        store: { taskDoneOn: { vipSign: YESTERDAY } }
    });
    await h.run();
    assert.ok(h.messages().includes("乐签 2026-10-04 未计入，已过当天无法补"),
        `hasMore=false 已经读完全部流水，再声明证据不足是白丢精度：${JSON.stringify(h.messages())}`);
});

test("乐签流水条目按日界取：昨天的日界内必须有非乐签条目也不算计入", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), ledger([
            MUSIC_SIGN(DAY_START + 4900),
            SVIP_GRANT(PREV_DAY_START + 4300),
            { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: PREV2_DAY_START + 90000, resourceId: 0 }
        ])],
        store: { taskDoneOn: { vipSign: YESTERDAY } }
    });
    await h.run();
    assert.ok(h.messages().includes("乐签 2026-10-04 未计入，已过当天无法补"),
        "同一天里 descript 不含「黑胶乐签每日打卡」的 +3 条目不是打卡流水");
});

// VER-M3：includes("乐签") 会把节点奖当每日打卡，从而吞掉当天唯一的补打机会。
test("含「乐签」二字的阶梯奖励 +30 不是每日打卡，不得当成今日已计入", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_LADDER_PRIZE_TODAY],
        store: { taskDoneOn: MORNING_DONE }
    });
    await h.run();
    assert.ok(!h.messages().includes("乐签复核：今日已计入"),
        `判据又被放宽了：阶梯奖励被当成了每日打卡：${JSON.stringify(h.messages())}`);
    assert.ok(h.messages().some((m) => m.startsWith("乐签复核：今日流水无乐签条目")), "必须走真缺口分支");
    assert.equal(punched(h), 1, "晨批已落门，本轮只有补打这一次打卡请求");
});

test("乐签复核：今日流水已有条目时零补打，重复触发也不补", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    await h.run();
    assert.equal(punched(h), 1, "已计入的日子不得再打一次（10-09 空打的回归锁）");
    assert.ok(h.messages().includes("乐签复核：今日已计入"));
});

test("乐签复核：今日流水无条目且已覆盖时补打一次，终态交给次日核对", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_NO_TODAY],
        store: { taskDoneOn: MORNING_DONE }
    });
    await h.run();

    assert.equal(punched(h), 1, "晨批已落门，只有晚批补打这一次");
    assert.ok(h.messages().some((m) => m.includes("今日流水无乐签条目，补打请求已受理，终态次日核对")),
        `实际：${JSON.stringify(h.messages())}`);
    assert.ok(!h.messages().some((m) => m.includes("未生效")),
        "旧措辞「补打后仍未生效」是假阴性，不得再出现");
    assert.equal(h.state.store.taskDoneOn.vipSignCheck, TODAY);

    await h.run();
    assert.equal(punched(h), 1, "当天不得重复补打");
});

test("乐签复核：补打被服务端否掉时措辞不得写成已受理", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED).map((r) =>
            r === OK_PUNCH ? { re: OK_PUNCH.re, body: { code: 200, data: false, message: "今日已打卡" } } : r),
        LEDGER_NO_TODAY],
        store: { taskDoneOn: MORNING_DONE }
    });
    await h.run();
    assert.ok(h.messages().some((m) => m.includes("补打本次未完成，终态次日核对")),
        `data:false 时不能写「已受理」：${JSON.stringify(h.messages())}`);
});

// ORCH-M3：同一次跑批里晨批刚打过（间隔几秒），复核不能把它读成缺口再打一次。
test("同一次跑批内晨批刚打过时，晚批复核不得二次打卡", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_NO_TODAY]
    });
    await h.run();
    assert.equal(punched(h), 1, "晨批 + 晚批二次打卡 = 空转写操作，回归锁");
    assert.ok(h.messages().some((m) => m.includes("今日打卡请求刚发出，流水尚未落地，本轮不补打")),
        `实际：${JSON.stringify(h.messages())}`);
    assert.ok(!("vipSignCheck" in h.state.store.taskDoneOn), "这轮没有结论，必须留给窗口内的下一次触发");
});

// VER-M2：响应没有 code 字段时 `{code: undefined}` 让所有哨兵失效。
test("流水响应缺 code 时按瞬态处理：既不写未计入，也不发补打请求", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), { re: LEDGER_RE, body: { message: "degraded", data: null } }]
    });
    await h.run();
    const messages = h.messages();
    assert.ok(!messages.some((m) => m.includes("未计入")), `证据不足却下了否定结论：${JSON.stringify(messages)}`);
    assert.equal(punched(h), 1, "只有晨批那一次打卡，复核的补打请求必须没发出去");
    assert.ok(messages.some((m) => m.startsWith("vipSignFinal 本轮失败（按瞬态重试）")),
        `形态错误必须走瞬态通道：${JSON.stringify(messages)}`);
    assert.ok(!("vipSignFinal" in (h.state.store.taskDoneOn || {})), "形态错误不落日期门");
    assert.ok(!("vipSignCheck" in (h.state.store.taskDoneOn || {})), "形态错误不落日期门");
    assert.ok(h.logs().filter((e) => e.level === "error" && /缺少 code 字段/.test(JSON.stringify(e.details))).length >= 2,
        "两个核对点的抛出原因都要落进日志，不然只看得到任务名");
});

test("乐签流水翻页：目标条目在第 2 页时仍判已计入，且确实读满两页", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), ledgerPages([
            ledger([SVIP_GRANT(DAY_START - 60000)], true).body,
            ledger([MUSIC_SIGN(PREV_DAY_START + 4300)]).body
        ])]
    });
    await h.run();
    assert.ok(h.messages().includes("乐签 2026-10-04 已计入"));
    assert.equal(ledgerReads(h), 2, "第 1 页 hasMore=true 时必须续读第 2 页");
    const entry = h.logs().find((e) => e.message === "乐签 2026-10-04 已计入");
    assert.equal(entry.details.pages, 2, "日志里的页数必须是实读数，不是常量上限（VER-L4）");
});

test("乐签复核：流水覆盖不到今天就声明无法判定并跳过补打", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_NOT_COVERED],
        store: { taskDoneOn: MORNING_DONE }
    });
    await h.run();
    const messages = h.messages();
    assert.ok(messages.some((m) => m === "乐签复核：流水未覆盖当天，暂不补打"),
        `补打是写操作，不能建立在没读到的流水上：${JSON.stringify(messages)}`);
    assert.equal(punched(h), 0, "证据不足时一次打卡请求都不该发");
    assert.ok(!("vipSignCheck" in (h.state.store.taskDoneOn || {})), "跳过补打不是结论，留给窗口内下一次触发");
});

test("首装日：本机没参与过的那一天不得写成漏签事故", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_MISS_YESTERDAY]
    });
    await h.run();
    const messages = h.messages();
    assert.ok(messages.some((m) => m.includes("无条目，但本机当天未参与打卡")),
        `首次安装当天会被读成断签事故：${JSON.stringify(messages)}`);
    assert.ok(!messages.some((m) => m.includes("未计入，已过当天无法补")));
});

test("乐签流水返回 301 时中止整批并提醒登录，不写终态日期门", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), { re: LEDGER_RE, body: { code: 301 } }]
    });
    await h.run();
    assert.deepEqual(h.state.notifications, ["netease_login_needed"]);
    assert.ok(!("vipSignFinal" in h.state.store.taskDoneOn), "未登录不得写入乐签终态日期门");
    assert.ok(!("vipSign" in h.state.store.taskDoneOn), "中止之后的打卡同样不得写门");
});

test("云贝任务：只领 completed 的条目，未完成的不触碰领取接口", async () => {
    const h = await harness({
        hour: 21,
        routes: ALL_OK.map((route) => route === OK_TODO ? {
            re: /usertool\/task\/todo\/query/,
            body: {
                code: 200,
                data: [
                    { completed: true, period: 1, userTaskId: 11, depositCode: 1304, taskPoint: 300 },
                    { completed: true, period: 1, userTaskId: 12, depositCode: 1304, taskPoint: 50 },
                    { completed: false, period: 2, userTaskId: 22, depositCode: 1305, taskPoint: 8 }
                ]
            }
        } : route)
    });
    await h.run();
    assert.equal(h.calls.filter((url) => /task\/point\/receive/.test(url)).length, 2, "两条 completed 各领一次");
});

test("云贝任务：全部未完成时零领取调用且当天不再重试", async () => {
    const h = await harness({
        hour: 21,
        routes: ALL_OK.map((route) => route === OK_TODO ? {
            re: /usertool\/task\/todo\/query/,
            body: { code: 200, data: [{ completed: false, period: 1, userTaskId: 11, depositCode: 1304 }] }
        } : route)
    });
    await h.run();
    assert.equal(h.calls.filter((url) => /task\/point\/receive/.test(url)).length, 0);
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY, "无待领也是明确结论，写入日期门");
});

test("云贝任务列表请求瞬态失败不写日期门，当晚下一次触发重试", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK, failOnce: /usertool\/task\/todo\/query/ });

    await h.run();
    assert.ok(!("yunbeiTask" in h.state.store.taskDoneOn), "失败的请求不应写入日期门");
    assert.equal(h.state.store.taskDoneOn.vipGrowth, TODAY, "同批其它任务应照常完成");

    await h.run();
    const attempts = h.calls.filter((url) => /usertool\/task\/todo\/query/.test(url)).length;
    assert.equal(attempts, 2, "云贝任务应在下次触发时重试");
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY, "重试成功后才写日期门");
});

test("接口返回 301 时中止整批，不再打下一个接口", async () => {
    const h = await harness({ hour: 9, routes: [{ re: /api\/point\/dailyTask/, body: { code: 301 } }, ...ALL_OK.slice(1)] });
    await h.run();
    assert.equal(h.calls.length, 1, "301 之后应立刻中止，不再打下一个接口");
    assert.deepEqual(h.state.notifications, ["netease_login_needed"]);
    assert.equal(h.state.store.taskDoneOn, undefined);
});

test("两个 alarm：签到批排到次日 00:00:05，领取批排到当天 21:00", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK });
    await h.run();
    const byName = Object.fromEntries(h.state.alarms.map((a) => [a.name, new Date(a.info.when)]));
    assert.equal(byName[ALARM_MORNING].getHours(), 0);
    assert.equal(byName[ALARM_MORNING].getMinutes(), 0);
    assert.equal(byName[ALARM_MORNING].getSeconds(), 5);
    assert.equal(byName[ALARM_MORNING].getDate(), 6, "00:00:05 必须是**次日**，写 setHours(0,...) 会排到过去");
    assert.equal(byName[ALARM_NIGHT].getHours(), 21);
    assert.equal(byName[ALARM_NIGHT].getDate(), 5, "09:30 触发时应排到当天 21:00");
});

test("瞬态失败留下的缺门，当晚窗口内必须还有触发机会", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK, failOnce: /usertool\/task\/todo\/query/ });
    await h.run();
    const next = new Date(lastAlarm(h, ALARM_NIGHT).info.when);
    assert.equal(next.getDate(), 5, "21:30 跑完后当晚剩余触发点不得为 0（SCH-H1）");
    assert.ok(next.getHours() >= 21 && next.getHours() <= 23, `重排必须还在窗口内，实际 ${next.toString()}`);
    assert.equal(next.getTime() - new Date(2026, 9, 5, 21, 30, 0).getTime(), 20 * 60 * 1000, "重排间隔 20 分钟");

    await h.run();
    assert.equal(h.calls.filter((url) => /usertool\/task\/todo\/query/.test(url)).length, 2, "重排的那一次真的会把缺门任务补上");
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY);
    assert.equal(new Date(lastAlarm(h, ALARM_NIGHT).info.when).getDate(), 6, "全部门落齐后顺延次日");
});

test("只有这两个 alarm 名会触发跑批", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.fireAlarm("someLegacyAlarm");
    assert.deepEqual(h.calls, [], "陌生闹钟名不得触发跑批");
    await h.fireAlarm(ALARM_MORNING);
    assert.ok(h.calls.length > 0, "本扩展的闹钟名必须触发跑批");
});

test("TASKS 的批次与顺序承载语义，改动顺序要一并改这条断言", async () => {
    const h = await harness({ hour: 9, routes: [] });
    assert.equal(h.evaluate('TASKS.map((t) => `${t.batch}:${t.key}`).join(",")'),
        [...MORNING_KEYS.map((k) => `morning:${k}`), ...NIGHT_KEYS.map((k) => `night:${k}`)].join(","),
        "vipSignFinal 必须排在 vipSign 之前：needLogin 的 break 会让后面的任务拿不到当天门");
});

test("SW 初始化按名字对账闹钟：缺失补排，已存在不重复", async () => {
    const missing = await harness({ hour: 9, routes: [] });
    assert.deepEqual(missing.initAlarms.map((a) => a.name).sort(), [ALARM_MORNING, ALARM_NIGHT].sort(),
        "闹钟被清掉后 SW 重启不会自愈");

    const seeded = await harness({
        hour: 9, routes: [],
        existingAlarms: [{ name: ALARM_MORNING, info: { when: new Date(2026, 9, 6, 0, 0, 5).getTime() } },
                          { name: ALARM_NIGHT, info: { when: new Date(2026, 9, 5, 21, 0, 0).getTime() } }]
    });
    assert.deepEqual(seeded.initAlarms, [], "已经排好的闹钟不得重复 create，否则把当晚重排机会挤掉");
});

test("chrome API 失败要说得像失败：lastError 一律进日志", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK, failOps: ["alarms.create", "action.setIcon"] });
    await h.run();
    const messages = h.messages();
    for (const op of ["alarms.create", "action.setIcon"]) {
        assert.ok(messages.some((m) => m.startsWith(`${op} 失败：`)), `${op} 的失败没有落日志：${JSON.stringify(messages)}`);
    }
    assert.ok(!messages.includes("Next check scheduled at"), "create 失败时不得再写「已排好」这句");

    const login = await harness({
        hour: 21, routes: ALL_OK, cookies: { __csrf: CSRF_VALUE }, failOps: ["notifications.create", "tabs.create"]
    });
    await login.run();
    const loginMessages = login.messages();
    for (const op of ["notifications.create", "tabs.create"]) {
        assert.ok(loginMessages.some((m) => m.startsWith(`${op} 失败：`)),
            `${op} 失败必须落日志（「登录提醒已发出」这类承诺不能假设成功）：${JSON.stringify(loginMessages)}`);
    }
    assert.ok(!loginMessages.includes("登录提醒已发出"));
});

test("日期门写不进盘就不算完成：内存门必须回滚", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK, failSet: (entries) => "taskDoneOn" in entries });
    await h.run();
    assert.equal(h.state.store.taskDoneOn, undefined, "桩件已拒绝写入，门不该出现在盘上");
    assert.ok(h.messages().some((m) => m.startsWith("storage.local.set 失败")));

    await h.run();
    assert.equal(h.calls.filter((url) => /api\/point\/dailyTask/.test(url)).length, 2,
        "盘上没落成功就不能在内存里当已完成，否则同一天会把成功的接口重打一遍");
});

test("本地状态读不到时本轮不跑批，而不是把当天接口重打一遍", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK, failGet: (keys) => keys.includes("taskDoneOn") });
    await h.run();
    assert.deepEqual(h.calls, [], "读不到日期门时不得发出任何业务请求");
    assert.ok(h.messages().includes("本地状态读取失败，本轮不跑批"));
});

test("会话刷新标签页：complete 不到来时靠兜底定时器关闭，且关不掉要说出来", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK });
    await h.run();
    assert.equal(h.state.tabs.length, 1, "签到批落了门才开标签页顺带刷新会话");
    h.fireTabUpdated(1, { status: "loading" });
    assert.deepEqual(h.state.removed, [], "complete 之前不该关闭");
    await h.fireTimer(30000);
    assert.deepEqual(h.state.removed, [1], "重定向出白名单时 complete 永不到来，兜底定时器必须把标签页关掉");

    const failing = await harness({ hour: 9, routes: ALL_OK, failOps: ["tabs.remove"] });
    await failing.run();
    failing.fireTabUpdated(1, { status: "complete" });
    await failing.fireTimer(2000);
    assert.ok(failing.messages().some((m) => m.startsWith("tabs.remove 失败")),
        `关不掉却写 "tab closed" 是假成功：${JSON.stringify(failing.messages())}`);
    assert.ok(!failing.messages().includes("Silent task completed and tab closed"));
});

test("凭据与任务名不落任何盘（防回归）", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    const serialized = JSON.stringify(h.state.store);
    for (const secret of [MUSIC_U_VALUE, CSRF_VALUE]) {
        assert.ok(!serialized.includes(secret), `${secret} 泄漏到了 store`);
    }
    assert.ok(!serialized.includes("taskName"), "云贝任务名不得落盘");
    assert.ok(!serialized.includes("听漫游"), "云贝任务中文名不得落盘");
    assert.ok(!serialized.includes("resourceId"), "流水条目本身不得落盘（只在函数内扫描）");
});

test("单条日志有上限：服务端自由文本不能整段把配额吃掉", async () => {
    const h = await harness({
        hour: 9,
        routes: ALL_OK.map((r) => (r === OK_PUNCH ? { re: OK_PUNCH.re, body: { code: 200, data: false, message: "x".repeat(3000) } } : r))
    });
    await h.run();
    const entry = h.logs().find((e) => e.message === "乐签：本次未完成");
    assert.ok(entry, "本次未完成的分支没有被记录");
    assert.ok(JSON.stringify(entry).length < 1200, `单条日志 ${JSON.stringify(entry).length} 字节，截断上限失效`);
});

test("manifest 的 host 白名单与源码里的端点主机整串对账", async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT, "manifest.base.json"), "utf8"));
    const source = await readFile(path.join(ROOT, "background.js"), "utf8");
    const hosts = [...source.matchAll(/^const (?:MUSIC_HOST|INTERFACE_HOST|VIP_CENTER_HOST) = "([^"]+)";$/gm)].map((m) => m[1]);
    assert.equal(hosts.length, 3, `源码里应有 3 个主机常量，实际 ${hosts.length}`);
    const declared = new Set(manifest.host_permissions);
    for (const host of hosts) {
        assert.ok(declared.has(`*://${host}/*`), `${host} 不在 host_permissions 里，请求会被平台拒掉`);
    }
    for (const pattern of manifest.host_permissions) {
        const host = pattern.replace(/^\*:\/\/(www\.)?/, "").replace(/\/\*$/, "");
        assert.ok(hosts.includes(host), `${pattern} 是多余权限：源码里没有对应端点，收窄到实际使用的 3 个主机`);
    }
});

// 夹具卫生：仓库是 PUBLIC 的，任何长得像真实标识的长数字串都不许出现在源码与测试里
// （v1 审查的 CRY-M5：weapi 测试的 userLotteryId 用了 12 位真实形态数字）。
// 豁免的只有两种：协议文档里的公开常量，以及一眼假的合成全零 key —— 它们都不是账号标识。
test("测试夹具与源码不含真实形态的长数字标识", async () => {
    const exempt = ["0102030405060708", "0CoJUm6Qyw8W8jud", "0000000000000000"];
    const files = ["tests/orchestration.test.mjs", "tests/weapi.test.mjs", "background.js", "weapi.js", "build.js"];
    for (const file of files) {
        const source = await readFile(path.join(ROOT, file), "utf8");
        const hits = source.split("\n")
            .map((line, i) => ({
                line: i + 1,
                text: (line.match(/(?<![\w.-])\d{9,}(?![\w.-])/g) || [])
                    .filter((digits) => !exempt.includes(digits)).join(",")
            }))
            .filter((h) => h.text);
        assert.deepEqual(hits, [], `${file} 里有长数字串，形态上像真实 id`);
    }
});

test("shouldRunNight 的边界：21:00 起、且晚批只要还有缺门就要跑", async () => {
    const h = await harness({ hour: 9, routes: [] });
    const today = h.evaluate("new Date(2026, 9, 5).toDateString()");
    const cases = [
        ["20:59:59", "new Date(2026, 9, 5, 20, 59, 59)", "{}", false],
        ["21:00:00", "new Date(2026, 9, 5, 21, 0, 0)", "{}", true],
        ["23:59:59", "new Date(2026, 9, 5, 23, 59, 59)", "{}", true],
        ["次日 00:00", "new Date(2026, 9, 6, 0, 0, 1)", "{}", false],
        ["只领了成长值", "new Date(2026, 9, 5, 22, 0, 0)", `{ vipGrowth: ${JSON.stringify(today)} }`, true],
        ["晚批三项全完成", "new Date(2026, 9, 5, 22, 0, 0)",
            `{ vipSignCheck: ${JSON.stringify(today)}, yunbeiTask: ${JSON.stringify(today)}, vipGrowth: ${JSON.stringify(today)} }`, false],
    ];
    for (const [label, dateExpr, doneOnExpr, expected] of cases) {
        assert.equal(h.evaluate(`shouldRunNight(${dateExpr}, ${doneOnExpr})`), expected, `${label} 判定错误`);
    }
});

test("登录提醒点击：复用已开标签页并把失败说出来", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK, cookies: { __csrf: CSRF_VALUE } });
    await h.run();
    h.state.queryResult = [{ id: 7, windowId: 3 }];
    await h.fireNotificationClick("netease_login_needed");
    assert.deepEqual(h.state.tabUpdates, [7], "应激活已有标签页而不是新开一个");
    assert.deepEqual(h.state.windowUpdates, [3]);
    assert.deepEqual(h.state.cleared, ["netease_login_needed"]);

    const failing = await harness({ hour: 21, routes: ALL_OK, cookies: { __csrf: CSRF_VALUE }, failOps: ["tabs.query"] });
    await failing.run();
    await failing.fireNotificationClick("netease_login_needed");
    assert.ok(failing.messages().some((m) => m.startsWith("tabs.query 失败")),
        `点击提醒却打不开页面时，日志必须说实话：${JSON.stringify(failing.messages())}`);
});
