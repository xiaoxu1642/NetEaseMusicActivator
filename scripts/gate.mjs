// 仓库门禁：跑两遍离线测试（Asia/Shanghai 与 UTC），并且读 tests/pass/fail/skipped 四个计数。
// 只看 EXIT=0 不够：被 skip 的守卫和宿主时区都会静默削掉守卫强度，而本仓没有 CI，
// 这类削掉只在换机器/换目录时才暴露（v1 审查的 XDOM-M3 整条就是这个）。
// 跑法：node scripts/gate.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZONES = ["Asia/Shanghai", "UTC"];

function parseTap(tap) {
    const grab = (key) => {
        const m = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
        return m ? Number(m[1]) : null;
    };
    return { tests: grab("tests"), pass: grab("pass"), fail: grab("fail"), skipped: grab("skipped") };
}

function run(tz) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--test", "--test-reporter=tap"], {
            cwd: ROOT,
            env: { ...process.env, TZ: tz }
        });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { out += d; });
        child.on("close", (code) => resolve({ tz, code, counts: parseTap(out), out }));
    });
}

const results = [];
for (const tz of ZONES) {
    const r = await run(tz);
    results.push(r);
    const c = r.counts;
    console.log(`TZ=${r.tz} exit=${r.code} tests=${c.tests} pass=${c.pass} fail=${c.fail} skipped=${c.skipped}`);
    if (r.code !== 0 || c.fail !== 0 || c.skipped !== 0 || c.tests !== c.pass || c.tests === null) {
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
