// 本机维护者脚本：把 weapi.js 的常量与两个只读参考仓库对账。
// 它**不是**仓库测试 —— 参考目录不在别人机器上，做成测试只会让 `node --test` 出现 skip，
// 而门禁要求 skipped === 0（守卫强度不得随环境漂移）。要跑就显式跑：node scripts/check-reference-crypto.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const weapi = require(path.join(ROOT, "weapi.js"));

const CANDIDATES = [
    process.env.NCM_REF_CRYPTO_JS,
    path.resolve(ROOT, "../NeteaseMusic-API-main/util/crypto.js")
].filter(Boolean);

const target = CANDIDATES.find((p) => existsSync(p));
if (!target) {
    console.error(`参考仓库不在以下位置，无法对账：\n  ${CANDIDATES.join("\n  ")}`);
    process.exit(1);
}

const source = readFileSync(target, "utf8");
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

const checks = [
    ["iv", source.includes("const iv = '0102030405060708'")],
    ["presetKey", source.includes("const presetKey = '0CoJUm6Qyw8W8jud'")],
    ["base62", source.includes(`const base62 = '${weapi.BASE62}'`)],
    ["公钥", source.includes(PUBLIC_KEY_PEM)],
    ["WEAPI_IV 字面", Buffer.from(weapi.WEAPI_IV).toString("utf8") === "0102030405060708"],
    ["WEAPI_PRESET_KEY 字面", Buffer.from(weapi.WEAPI_PRESET_KEY).toString("utf8") === "0CoJUm6Qyw8W8jud"],
    ["模数 == 公钥模数", weapi.WEAPI_RSA_MODULUS.toString(16) ===
        Buffer.from(crypto.createPublicKey(PUBLIC_KEY_PEM).export({ format: "jwk" }).n, "base64url").toString("hex")]
];

const bad = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
console.log(`REF=${target}`);
if (bad.length) {
    console.error(`参考仓库对账不通过：${bad.map(([name]) => name).join(", ")}`);
    process.exit(1);
}
