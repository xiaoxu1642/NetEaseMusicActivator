// 发版前对账：产物 ↔ 工作区源码 ↔ 版本四处，全部用 blob 哈希 + 文件名当锚点。
// 不用条目时间戳：v1.1.0 包内文件的 mtime 比 asset 上传晚 8h37m，拿它当锚点只会造出假矛盾。
// 跑法：node scripts/pre-release.mjs --tag v1.2.5
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const expectedTag = tagIndex >= 0 ? args[tagIndex + 1] : null;

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
// --no-filters：取工作区文件的**原始字节**哈希，绕开 core.autocrlf / .gitattributes 的换行转换，
// 否则同一次 checkout 在不同机器上会算出不同结果（REL-H1）。
const blobHash = (file) => git("hash-object", "--no-filters", "--", file);

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

const distManifestPath = path.join(ROOT, "dist", "chrome", "manifest.json");
if (!existsSync(distManifestPath)) {
    console.error("dist/chrome/manifest.json 不存在 —— 先跑 node build.js");
    process.exit(1);
}
const distManifest = JSON.parse(readFileSync(distManifestPath, "utf8"));
const baseManifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.base.json"), "utf8"));

check("manifest.base.json 版本 == 包内 manifest 版本",
    distManifest.version === baseManifest.version, `${baseManifest.version} vs ${distManifest.version}`);

// 产物必须逐字节等于当前工作区源码（改了代码没重新 build 就发版，是这类仓库最常见的假发版）。
const packageFiles = ["background.js", "weapi.js", "LICENSE",
    ...["red16", "red48", "red128", "gray16", "gray48", "gray128"].map((n) => `images/${n}.png`)];
for (const file of packageFiles) {
    const src = path.join(ROOT, file);
    const built = path.join(ROOT, "dist", "chrome", file);
    if (!existsSync(src) || !existsSync(built)) {
        check(`包内含 ${file}`, false, "文件不存在");
        continue;
    }
    check(`${file} 产物 == 源码`, blobHash(src) === blobHash(built),
        `${blobHash(built)} vs ${blobHash(src)}`);
}

// LICENSE 被 git 跟踪 && 在包里 —— 六个已发布 zip 缺它的那条 T 级就在这里现形。
let trackedLicense = "";
try {
    trackedLicense = git("ls-files", "LICENSE");
} catch (_) {
    trackedLicense = "";
}
check("LICENSE 被仓库跟踪", trackedLicense === "LICENSE");

const version = distManifest.version;
if (expectedTag) {
    check("tag 名与 manifest 版本一致", expectedTag === `v${version}`, `${expectedTag} vs v${version}`);
    const pointsAt = git("tag", "--points-at", "HEAD").split(/\r?\n/).filter(Boolean);
    if (pointsAt.includes(expectedTag)) check("tag 已指向 HEAD", true, expectedTag);
    else check("tag 已指向 HEAD", false, `HEAD 上的 tag: ${pointsAt.join(", ") || "无"}（还没打？）`);
} else {
    const headTags = git("tag", "--points-at", "HEAD").split(/\r?\n/).filter(Boolean);
    check("HEAD 上的 tag 版本 == manifest 版本",
        headTags.length === 0 || headTags.every((t) => t === `v${version}`),
        `${headTags.join(", ") || "尚未打 tag"} vs v${version}`);
}

for (const c of checks) console.log(`${c.ok ? "OK  " : "FAIL"} ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
const failed = checks.filter((c) => !c.ok);
if (failed.length) {
    console.error(`PRE-RELEASE=FAIL ${failed.length} 项不通过`);
    process.exit(1);
}
console.log("PRE-RELEASE=OK 产物、版本、LICENSE、tag 四项对平");
