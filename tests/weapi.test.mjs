// weapi.js 的离线等价测试：不联网、不碰 chrome.*，只验证加密层逐字节正确。
// 跑法：node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const weapi = require("../weapi.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF_CRYPTO_JS = path.resolve(HERE, "../../NeteaseMusic-API-main/util/crypto.js");

// 网易云 weapi 公钥（公开常量，与 NeteaseMusic-API-main/util/crypto.js:8-10 同一把）。
const REF_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

// 参考实现刻意走 Node/OpenSSL 自己的 AES 与 RSA，和 weapi.js 的 WebCrypto + BigInt
// 是两条完全独立的代码路径，所以这里对得上才算真的对得上。
function referenceEncrypt(payload, secretKey) {
    const iv = Buffer.from("0102030405060708", "utf8");
    const aesCbc = (key, data) => {
        const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
        return Buffer.concat([cipher.update(Buffer.from(data, "utf8")), cipher.final()]);
    };

    const once = aesCbc(Buffer.from("0CoJUm6Qyw8W8jud", "utf8"), JSON.stringify(payload)).toString("base64");
    const params = aesCbc(Buffer.from(secretKey, "utf8"), once).toString("base64");

    const reversed = Buffer.from([...secretKey].reverse().join(""), "utf8");
    const encSecKey = crypto
        .publicEncrypt(
            { key: REF_PUBLIC_KEY_PEM, padding: crypto.constants.RSA_NO_PADDING },
            Buffer.concat([Buffer.alloc(128 - reversed.length), reversed])
        )
        .toString("hex");

    return { params, encSecKey };
}

test("params 与 Node AES-128-CBC 实现逐字节一致", async () => {
    const cases = [
        ["空对象", {}],
        ["单字段", { a: 1 }],
        ["真实载荷 csrf_token", { userLotteryId: "293239602686", depositCode: "0", csrf_token: "deadbeef" }],
        ["中文与 emoji", { name: "黑胶乐签", note: "云贝直接充值到账 🎵", nested: { list: [1, 2, 3] } }],
        ["长载荷", { items: Array.from({ length: 120 }, (_, i) => ({ id: i, label: `任务 ${i}` })) }],
    ];

    for (const [label, payload] of cases) {
        const secretKey = "abcdefghij012345";
        const actual = await weapi.weapiEncrypt(payload, secretKey);
        assert.deepEqual(actual, referenceEncrypt(payload, secretKey), `${label} 不一致`);
    }
});

test("encSecKey 与 OpenSSL 裸 RSA(no padding) 一致且恒为 256 位 hex", async () => {
    for (const secretKey of ["abcdefghij012345", "0000000000000000", "zzzzzzzzzzzzzzzz", "aB3xY9qLm2Np7RsT"]) {
        const { encSecKey } = await weapi.weapiEncrypt({}, secretKey);
        assert.match(encSecKey, /^[0-9a-f]{256}$/, `secretKey=${secretKey} 的 encSecKey 形态不对`);
        assert.equal(encSecKey, referenceEncrypt({}, secretKey).encSecKey);
    }
});

test("随机 secretKey 恒为 16 位 base62 且不重复", () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
        const key = weapi.randomSecretKey();
        assert.match(key, /^[0-9a-zA-Z]{16}$/, `生成了非法 key: ${key}`);
        seen.add(key);
    }
    assert.equal(seen.size, 500, "500 次生成出现重复，随机源可疑");
});

test("模数常量等于官方公钥的真实模数", () => {
    const jwk = crypto.createPublicKey(REF_PUBLIC_KEY_PEM).export({ format: "jwk" });
    assert.equal(weapi.WEAPI_RSA_MODULUS.toString(16), Buffer.from(jwk.n, "base64url").toString("hex"));
    assert.equal(weapi.WEAPI_RSA_EXPONENT, BigInt("0x" + Buffer.from(jwk.e, "base64url").toString("hex")));
});

test("modPow 处理指数为 0 与底数大于模数的情况", () => {
    assert.equal(weapi.modPow(7n, 0n, 11n), 1n);
    assert.equal(weapi.modPow(123n, 1n, 7n), BigInt(123 % 7));
    assert.equal(weapi.modPow(3n, 13n, 1000000007n), 1594323n);
});

// 这条只在能读到参考仓库时跑，换机器缺目录就跳过，不让它变成假失败。
test("常量与 NeteaseMusic-API-main/util/crypto.js 保持同步", (t) => {
    if (!existsSync(REF_CRYPTO_JS)) return t.skip(`参考仓库不在 ${REF_CRYPTO_JS}`);

    const source = readFileSync(REF_CRYPTO_JS, "utf8");
    assert.ok(source.includes(`const iv = '0102030405060708'`), "iv 与参考实现不一致");
    assert.ok(source.includes(`const presetKey = '0CoJUm6Qyw8W8jud'`), "presetKey 与参考实现不一致");
    assert.ok(source.includes(`const base62 = '${weapi.BASE62}'`), "base62 字母表与参考实现不一致");
    assert.ok(source.includes(Buffer.from(REF_PUBLIC_KEY_PEM).toString("utf8").trim()), "公钥与参考实现不一致");
    assert.equal(Buffer.from(weapi.WEAPI_IV).toString("utf8"), "0102030405060708");
    assert.equal(Buffer.from(weapi.WEAPI_PRESET_KEY).toString("utf8"), "0CoJUm6Qyw8W8jud");
});
