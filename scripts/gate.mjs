// 仓库门禁：跑两遍离线测试（Asia/Shanghai 与 UTC），并且读 tests/pass/fail/skipped 四个计数。
// 只看 EXIT=0 不够：被 skip 的守卫和宿主时区都会静默削掉守卫强度，而本仓没有 CI，
// 这类削掉只在换机器/换目录时才暴露（v1 审查的 XDOM-M3 整条就是这个）。
// 跑法：node scripts/gate.mjs
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZONES = ["Asia/Shanghai", "UTC"];
// 必须显式列出项目自有测试：node --test 无参数会扫描整个工作区，把被 .gitignore 忽略的
// docs/参考文件/** 里那 21 个联网测试（需要 API key）一并发现并判红，门禁因此恒 FAIL。
const TEST_FILES = ["tests/weapi.test.mjs", "tests/orchestration.test.mjs"];
// 单个时区的子进程超过这个毫秒数就杀掉整棵进程树并判失败：门禁宁可快速失败，也不能挂死。
const ZONE_TIMEOUT_MS = 120000;

function parseTap(tap) {
    const grab = (key) => {
        const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
        return m ? Number(m[1]) : null;
    };
    return { tests: grab("tests"), pass: grab("pass"), fail: grab("fail"), skipped: grab("skipped") };
}

// 杀掉子进程连同它派生的测试进程（node --test 会为每个测试文件再起一个子进程）。
function killTree(child) {
    if (process.platform === "win32" && child.pid) {
        try {
            execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            return;
        } catch (_) {
            // taskkill 不可用就退回 kill
        }
    }
    try {
        child.kill("SIGKILL");
    } catch (_) {
        // 进程已经退出
    }
}

function run(tz) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...TEST_FILES], {
            cwd: ROOT,
            env: { ...process.env, TZ: tz }
        });
        let out = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            timedOut = true;
            killTree(child);
        }, ZONE_TIMEOUT_MS);
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ tz, code: timedOut ? 124 : code, timedOut, counts: parseTap(out), out });
        });
    });
}

// 两个时区并行跑（测试只读不写盘，互不干扰），但打印顺序仍按 ZONES 固定，不受谁先跑完影响。
const results = await Promise.all(ZONES.map((tz) => run(tz)));
for (const r of results) {
    const c = r.counts;
    console.log(`TZ=${r.tz} exit=${r.code} tests=${c.tests} pass=${c.pass} fail=${c.fail} skipped=${c.skipped}`);
    if (r.timedOut) {
        console.error(`TZ=${r.tz} 门禁不合格：子进程超过 ${ZONE_TIMEOUT_MS / 1000} 秒未结束，已强制结束`);
    } else if (r.code !== 0 || c.fail !== 0 || c.skipped !== 0 || c.tests !== c.pass || c.tests === null) {
        const detail = r.out.split("\n").filter((line) => /^not ok/.test(line)).join("\n");
        console.error(`TZ=${r.tz} 门禁不合格：${detail || "没有 not ok 行，说明计数本身缺失或有 skip"}`);
    }
}

const bad = results.filter((r) => r.code !== 0 || r.counts.fail !== 0 || r.counts.skipped !== 0 ||
    r.counts.tests === null || r.counts.tests !== r.counts.pass);
if (bad.length) {
    console.error(`GATE=FAIL (${bad.map((r) => r.tz).join(", ")})`);
    process.exit(1);
}
console.log("GATE=OK 两个时区各跑一遍，0 fail / 0 skipped");
