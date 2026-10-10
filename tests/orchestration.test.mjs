// 调度与门控的行为测试：在独立 vm 上下文里加载扩展真身，用 chrome/fetch 桩件离线跑
// checkAndRun，验证「21:00 硬窗口、每天最多一次、瞬态失败不写门、乐签只在成长值流水缺条目时补打」这些约束真的生效。
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
// 乐签计入的唯一判据 = 成长值流水里当天那条「黑胶乐签每日打卡」。sign/info 的 recordId 属于另一条
// 更慢、且会整段不出的唱片记录行流水线（10-09 流水已计 +3、recordId 到 +41h 仍为 0），不再读它。
// 冻结的时钟是 2026-10-05，所以"今天"= 2026-10-05，晨批终态核对的"昨天"= 2026-10-04。
// 日界必须按本地时区构造，与 background.js 的 dayBounds 同源（宿主与 vm 同一时区，显式传参不吃冻结时钟）。
const DAY_START = new Date(2026, 9, 5).getTime();
const PREV_DAY_START = new Date(2026, 9, 4).getTime();
const PREV2_DAY_START = new Date(2026, 9, 3).getTime();
const LEDGER_RE = /weapi\/vipnewcenter\/app\/level\/growth\/details\?/;
const ledger = (details, hasMore = false) => ({
    re: LEDGER_RE,
    body: { code: 200, message: "success", data: { hasMore, details } }
});
// 今天与昨天都已计入，另掺一条"昨天 23:00 的 SVIP 发放"：它落在昨天的日界内但不是乐签，必须不算数。
const LEDGER_COUNTED = ledger([
    { descript: "黑胶乐签每日打卡", growthPoint: 3, time: DAY_START + 4900, resourceId: 0 },
    { descript: "黑胶SVIP每日发放", growthPoint: 20, time: DAY_START - 3600000, resourceId: 168404218 },
    { descript: "黑胶乐签每日打卡", growthPoint: 3, time: PREV_DAY_START + 4300, resourceId: 0 },
    { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: PREV2_DAY_START + 90000, resourceId: 5048000 }
]);
// 昨天被覆盖到（有更早的条目垫底）却没有乐签条目 → 真没计入。
const LEDGER_MISS_YESTERDAY = ledger([
    { descript: "黑胶乐签每日打卡", growthPoint: 3, time: DAY_START + 4900, resourceId: 0 },
    { descript: "黑胶SVIP每日发放", growthPoint: 20, time: PREV_DAY_START + 500000, resourceId: 168404218 },
    { descript: "黑胶SVIP每日发放", growthPoint: 20, time: PREV2_DAY_START + 500000, resourceId: 168404218 }
]);
// 全部条目都晚于"昨天"的日界 → 连日界都没翻到，只能说证据不足，不得写成未计入。
const LEDGER_NOT_COVERED = ledger([
    { descript: "黑胶乐签每日打卡", growthPoint: 3, time: DAY_START + 4900, resourceId: 0 },
    { descript: "黑胶SVIP每日发放", growthPoint: 20, time: DAY_START + 3600000, resourceId: 168404218 }
]);
// 昨天有、今天没有：晚批必须补打一次。
const LEDGER_NO_TODAY = ledger([
    { descript: "黑胶乐签每日打卡", growthPoint: 3, time: PREV_DAY_START + 4300, resourceId: 0 },
    { descript: "黑胶SVIP每日发放", growthPoint: 20, time: PREV2_DAY_START + 500000, resourceId: 168404218 }
]);
// 只有今天当天的非乐签条目：晨批核昨日、晚批核今日都覆盖不到 → 两处都只能"无法判定"，且都不补打。
const LEDGER_ONLY_TODAY_NOISE = ledger([
    { descript: "黑胶SVIP每日发放", growthPoint: 20, time: DAY_START + 3600000, resourceId: 168404218 },
    { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: DAY_START + 7200000, resourceId: 5048000 }
]);
// 翻页桩件：limit/offset 在 POST body 里，fetch 桩件只看得到 URL，所以按调用序号发页。
function ledgerPages(bodies) {
    let n = 0;
    return { re: LEDGER_RE, body: () => bodies[Math.min(n++, bodies.length - 1)] };
}
const ALL_OK = [OK_SIGN, OK_YUNBEI, NO_STAGE, LEDGER_COUNTED, OK_PUNCH, OK_TODO, OK_RECEIVE, OK_CLAIM];

const TODAY = "Mon Oct 05 2026";
const MORNING_DONE = { dailyTask: TODAY, yunbeiSign: TODAY, yunbeiStage: TODAY, vipSignFinal: TODAY, vipSign: TODAY };
const NIGHT_DONE = { vipSignCheck: TODAY, yunbeiTask: TODAY, vipGrowth: TODAY };
const ALL_DONE = { ...MORNING_DONE, ...NIGHT_DONE };

function makeChrome(state) {
    const noopListeners = { addListener() {} };
    return {
        storage: {
            local: {
                get(keys, callback) {
                    const wanted = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(state.store));
                    const result = {};
                    for (const key of wanted) if (key in state.store) result[key] = structuredClone(state.store[key]);
                    callback(result);
                },
                set(entries, callback) {
                    for (const [key, value] of Object.entries(entries)) state.store[key] = structuredClone(value);
                    callback && callback();
                },
            },
        },
        cookies: {
            get(query, callback) {
                const value = state.cookies[query.name];
                callback(value ? { value } : null);
            },
        },
        alarms: { create: (name, info) => state.alarms.push({ name, info }), onAlarm: noopListeners },
        action: { setIcon: () => {}, setTitle: () => {}, onClicked: noopListeners },
        notifications: { create: (id) => state.notifications.push(id), clear: () => {}, onClicked: noopListeners },
        tabs: {
            create: (options, callback) => { state.tabs.push(options.url); callback && callback({ id: 1 }); },
            remove: () => {},
            query: (query, callback) => callback([]),
            update: () => {},
            onUpdated: { addListener() {}, removeListener() {} },
        },
        runtime: { onStartup: noopListeners, onInstalled: noopListeners, lastError: null },
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

async function harness({ hour = 9, routes = [], cookies = { MUSIC_U: "u", __csrf: "c" }, store = {}, failOnce } = {}) {
    const state = { store, cookies, alarms: [], notifications: [], tabs: [] };
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
        setTimeout,
        clearTimeout,
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

    // 持久化日志是串行队列，断言前先排空。
    const drain = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

    return {
        state,
        calls,
        async run() {
            await vm.runInContext("checkAndRun()", context);
            await drain();
        },
        async runConcurrently(times) {
            await vm.runInContext(`Promise.all([${Array(times).fill("checkAndRun()").join(", ")}])`, context);
            await drain();
        },
        evaluate(script) {
            return vm.runInContext(script, context);
        },
    };
}

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
    assert.equal(h.calls.filter((url) => /vip-center-bff\/task\/sign/.test(url)).length, 1, "晨批照常打卡");
    assert.equal(h.calls.filter(GROWTH_READ).length, 1, "晨批只读一次流水核对昨日终态");
    assert.deepEqual(h.state.store.taskDoneOn, MORNING_DONE);
    assert.ok(!("vipGrowth" in h.state.store.taskDoneOn), "窗口外不应写入 vipGrowth 日期门");
});

test("窗口内（21:30）跑完整晚批，并落下本地账目", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    assert.equal(h.calls.filter((url) => /reward\/getall/.test(url)).length, 1, "getall 应恰好调用一次");
    assert.equal(h.calls.filter((url) => /app\/level\/growth\/details/.test(url)).length, 2, "晨批核昨日 + 晚批复核今日");
    assert.equal(h.calls.filter((url) => /task\/point\/receive/.test(url)).length, 1, "completed 的条目逐个领取");
    assert.equal(h.calls.filter((url) => /weapi\/vip-center-bff\/task\/sign/.test(url)).length, 1,
        "今日流水已有乐签条目时不得补打，打卡请求全天只有晨批那一次");
    assert.equal(h.state.store.taskDoneOn.vipSignCheck, TODAY);
    assert.equal(h.state.store.taskDoneOn.yunbeiTask, TODAY);
    assert.equal(h.state.store.taskDoneOn.vipGrowth, TODAY);

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
    assert.equal(h.calls.filter((url) => /app\/level\/growth\/details/.test(url)).length, 1, "复核缺门应触发");
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

test("无 MUSIC_U 时零请求，只提醒登录", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK, cookies: { __csrf: "c" } });
    await h.run();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.state.notifications, ["netease_login_needed"]);
    assert.equal(h.state.store.taskDoneOn, undefined, "未登录不得写任何日期门");
});

test("瞬态失败不写日期门，下次触发会重试且不弹登录提醒", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK, failOnce: /weapi\/pointmall\/user\/sign\?/ });

    await h.run();
    assert.ok(!("yunbeiSign" in h.state.store.taskDoneOn), "失败的请求不应写入日期门");
    assert.ok("dailyTask" in h.state.store.taskDoneOn, "同批其它任务应照常完成");
    assert.deepEqual(h.state.notifications, [], "瞬态失败不该弹登录提醒");

    await h.run();
    const attempts = h.calls.filter((url) => /weapi\/pointmall\/user\/sign\?/.test(url)).length;
    assert.equal(attempts, 2, "云贝签到应在下次触发时重试");
    assert.equal(h.state.store.taskDoneOn.yunbeiSign, TODAY, "重试成功后才写日期门");
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

test("乐签晨批终态：流水覆盖到昨日却无乐签条目时报未计入，且不为过期的一天额外打卡", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_MISS_YESTERDAY]
    });
    await h.run();
    assert.ok(h.state.store.runtimeLogs.some((entry) => entry.message.includes("乐签 2026-10-04 未计入")));
    assert.equal(h.calls.filter((url) => /vip-center-bff\/task\/sign/.test(url)).length, 1,
        "昨天已无法补救，只能打今天这一次");
});

test("乐签晨批终态：流水没覆盖到昨日时只能声明无法判定，不得写成未计入", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_NOT_COVERED]
    });
    await h.run();
    const messages = h.state.store.runtimeLogs.map((entry) => entry.message);
    assert.ok(messages.some((message) => message.includes("乐签 2026-10-04 无法判定：流水未覆盖当天")));
    assert.ok(!messages.some((message) => message.includes("未计入")), "证据不足不得降级成失败断言");
});

test("乐签流水条目按日界取：昨天的日界内必须有非乐签条目也不算计入", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), ledger([
            { descript: "黑胶乐签每日打卡", growthPoint: 3, time: DAY_START + 4900, resourceId: 0 },
            { descript: "黑胶SVIP每日发放", growthPoint: 20, time: PREV_DAY_START + 4300, resourceId: 168404218 },
            { descript: "每日听VIP歌曲 会员任务", growthPoint: 3, time: PREV2_DAY_START + 90000, resourceId: 5048000 }
        ])]
    });
    await h.run();
    assert.ok(h.state.store.runtimeLogs.some((entry) => entry.message.includes("乐签 2026-10-04 未计入")),
        "同一天里 descript 不含「乐签」的 +3 条目不是打卡流水");
});

test("乐签复核：今日流水已有条目时零补打，重复触发也不补", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    await h.run();
    const punches = h.calls.filter((url) => /weapi\/vip-center-bff\/task\/sign/.test(url));
    assert.equal(punches.length, 1, "已计入的日子不得再打一次（10-09 空打的回归锁）");
    assert.ok(h.state.store.runtimeLogs.some((entry) => entry.message === "乐签复核：今日已计入"));
});

test("乐签复核：今日流水无条目且已覆盖时补打一次，终态交给次日核对", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_NO_TODAY]
    });
    await h.run();

    assert.equal(h.calls.filter((url) => /weapi\/vip-center-bff\/task\/sign/.test(url)).length, 2, "晨批试打 + 晚批补打各一次");
    assert.ok(h.state.store.runtimeLogs.some((entry) => entry.message.includes("今日流水无乐签条目，已补打，终态次日核对")));
    assert.ok(!h.state.store.runtimeLogs.some((entry) => entry.message.includes("未生效")),
        "旧措辞「补打后仍未生效」是假阴性，不得再出现");
    assert.equal(h.state.store.taskDoneOn.vipSignCheck, TODAY);

    await h.run();
    assert.equal(h.calls.filter((url) => /weapi\/vip-center-bff\/task\/sign/.test(url)).length, 2, "当天不得重复补打");
});

test("乐签复核：流水覆盖不到今天就声明无法判定并跳过补打", async () => {
    const h = await harness({
        hour: 21,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), LEDGER_ONLY_TODAY_NOISE]
    });
    await h.run();
    const messages = h.state.store.runtimeLogs.map((entry) => entry.message);
    assert.ok(messages.some((message) => message.includes("乐签 2026-10-04 无法判定")));
    assert.ok(messages.some((message) => message === "乐签复核：流水未覆盖当天，暂不补打"),
        "补打是写操作，不能建立在没读到的流水上");
    assert.equal(h.calls.filter((url) => /weapi\/vip-center-bff\/task\/sign/.test(url)).length, 1);
});

test("乐签流水翻页：目标条目在第 2 页时仍判已计入，且确实读满两页", async () => {
    const h = await harness({
        hour: 9,
        routes: [...ALL_OK.filter((route) => route !== LEDGER_COUNTED), ledgerPages([
            ledger([{ descript: "黑胶SVIP每日发放", growthPoint: 20, time: DAY_START - 60000, resourceId: 168404218 }], true).body,
            ledger([{ descript: "黑胶乐签每日打卡", growthPoint: 3, time: PREV_DAY_START + 4300, resourceId: 0 }]).body
        ])]
    });
    await h.run();
    assert.ok(h.state.store.runtimeLogs.some((entry) => entry.message === "乐签 2026-10-04 已计入"));
    assert.equal(h.calls.filter((url) => /app\/level\/growth\/details/.test(url)).length, 2,
        "第 1 页 hasMore=true 时必须续读第 2 页");
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

test("接口返回 301 时中止整批并提醒登录，不写日期门", async () => {
    const h = await harness({ hour: 9, routes: [{ re: /api\/point\/dailyTask/, body: { code: 301 } }, ...ALL_OK.slice(1)] });
    await h.run();
    assert.equal(h.calls.length, 1, "301 之后应立刻中止，不再打下一个接口");
    assert.deepEqual(h.state.notifications, ["netease_login_needed"]);
    assert.equal(h.state.store.taskDoneOn, undefined);
});

test("两个 alarm：签到批排到 00:00:05，领取批排到 21:00", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK });
    await h.run();
    const byName = Object.fromEntries(h.state.alarms.map((a) => [a.name, new Date(a.info.when)]));
    assert.equal(byName.smartDailyNetEaseCheck.getHours(), 0);
    assert.equal(byName.smartDailyNetEaseCheck.getMinutes(), 0);
    assert.equal(byName.smartDailyNetEaseCheck.getSeconds(), 5);
    assert.equal(byName.netEaseVipGrowthClaim.getHours(), 21);
    assert.equal(byName.netEaseVipGrowthClaim.getDate(), 5, "09:30 触发时应排到当天 21:00");
});

test("窗口内触发后，领取 alarm 顺延到次日 21:00，当晚不再重复", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    const claim = h.state.alarms.find((a) => a.name === "netEaseVipGrowthClaim");
    const next = new Date(claim.info.when);
    assert.equal(next.getHours(), 21);
    assert.equal(next.getDate(), 6, "应排到明天，避免当晚再触发一次");
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
