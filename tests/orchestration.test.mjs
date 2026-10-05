// 调度与门控的行为测试：在独立 vm 上下文里加载扩展真身，用 chrome/fetch 桩件离线跑
// checkAndRun，验证「21:00 硬窗口、每天最多一次、瞬态失败不写门」这些约束真的生效。
// 上下文必须独立于宿主 realm：伪造 Date 泄漏到宿主会污染测试进程自身的序列化。
// 跑法：node --test tests/
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
const OK_VIP_SIGN = { re: /vip-center-bff\/task\/sign/, body: { code: 200, data: true } };
const OK_CLAIM = { re: /task\/reward\/getall/, body: { code: 200, data: { result: true } } };
const ALL_OK = [OK_SIGN, OK_YUNBEI, NO_STAGE, OK_VIP_SIGN, OK_CLAIM];

const TODAY = "Mon Oct 05 2026";
const MORNING_DONE = { dailyTask: TODAY, yunbeiSign: TODAY, yunbeiStage: TODAY, vipSign: TODAY };

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
        return { ok: true, status: 200, json: async () => matched.body };
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
    // 真实加载路径：background.js 顶层会 importScripts('weapi.js')，两个文件共享同一全局词法作用域。
    context.importScripts = (file) => vm.runInContext(sources[file], context, { filename: file });
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

    const hosts = ["/api/point/dailyTask", "/weapi/pointmall/user/sign?", "/weapi/pointmall/user/sign/config?",
        "/weapi/vip-center-bff/task/sign", "/weapi/vipnewcenter/app/level/task/reward/getall"];
    for (const endpoint of hosts) {
        const hits = h.calls.filter((url) => url.includes(endpoint));
        assert.equal(hits.length, 1, `${endpoint} 被打了几次：${hits.length}`);
    }
    assert.equal(h.state.store.vipGrowthLog.length, 1, "并发触发不得写出两条当日账目");
    assert.equal(h.state.store.taskDoneOn.vipGrowth, TODAY);
});

test("窗口外（09:30）只跑签到批，绝不触碰成长值接口", async () => {
    const h = await harness({ hour: 9, routes: ALL_OK });
    await h.run();
    assert.equal(h.calls.length, 4, `期望 4 次请求，实际 ${h.calls.length}`);
    assert.ok(h.calls.every((url) => !/reward\/getall/.test(url)), "窗口外不应调用 getall");
    assert.deepEqual(h.state.store.taskDoneOn, MORNING_DONE);
    assert.ok(!("vipGrowth" in h.state.store.taskDoneOn), "窗口外不应写入 vipGrowth 日期门");
});

test("窗口内（21:30）追加领取一次，并落下本地账目", async () => {
    const h = await harness({ hour: 21, routes: ALL_OK });
    await h.run();
    assert.equal(h.calls.filter((url) => /reward\/getall/.test(url)).length, 1, "getall 应恰好调用一次");
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
            OK_VIP_SIGN,
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
    const h = await harness({ hour: 22, routes: ALL_OK, store: { taskDoneOn: { ...MORNING_DONE, vipGrowth: TODAY } } });
    await h.run();
    assert.deepEqual(h.calls, [], "全部任务当天已完成时应零请求");
    assert.equal(h.state.store.vipGrowthLog, undefined, "不应重复记账");
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

test("shouldRunNight 的边界就是 21:00 与当天日期门", async () => {
    const h = await harness({ hour: 9, routes: [] });
    const today = h.evaluate("new Date(2026, 9, 5).toDateString()");
    const cases = [
        ["20:59:59", "new Date(2026, 9, 5, 20, 59, 59)", "{}", false],
        ["21:00:00", "new Date(2026, 9, 5, 21, 0, 0)", "{}", true],
        ["23:59:59", "new Date(2026, 9, 5, 23, 59, 59)", "{}", true],
        ["次日 00:00", "new Date(2026, 9, 6, 0, 0, 1)", "{}", false],
        ["当天已领", "new Date(2026, 9, 5, 22, 0, 0)", `{ vipGrowth: ${JSON.stringify(today)} }`, false],
    ];
    for (const [label, dateExpr, doneOnExpr, expected] of cases) {
        assert.equal(h.evaluate(`shouldRunNight(${dateExpr}, ${doneOnExpr})`), expected, `${label} 判定错误`);
    }
});
