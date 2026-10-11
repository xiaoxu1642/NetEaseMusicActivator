// weapi.js 的离线等价测试：不联网、不碰 chrome.*，只验证加密层逐字节正确。
// 跑法：node --test（在仓库根目录运行；带目录参数的 node --test tests/ 在 Node 25 下会报 MODULE_NOT_FOUND）
// 门禁要求 skipped === 0，所以这里不许出现条件跳过；与本机参考仓库的常量对账在 scripts/check-reference-crypto.mjs。
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const weapi = require("../weapi.js");

// 网易云 weapi 公钥（公开常量，与 NeteaseMusic-API-main/util/crypto.js:8-10 同一把）。
const REF_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

// 参考实现只在**原语层**独立（Node/OpenSSL 的 AES 与 RSA vs weapi.js 的 WebCrypto + BigInt）；
// 两层 CBC 的组合顺序和 reverse() 表达式与 weapi.js 同源，所以两侧同时写错时这条抓不到，
// 组合次序另由下面的黄金向量（不依赖任何参考实现）钉住。
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

// 黄金向量：key 与载荷都写死，期望值是**离线算出来的一次性快照**，换机器、缺参考目录都不得影响它。
// 没有这条，加密层的正确性就完全依赖同机能读到 NeteaseMusic-API-main（守卫强度随环境漂移）。
const GOLDEN = {
    payload: { userLotteryId: "PRIVILEGE_ID_PLACEHOLDER", depositCode: "0", csrf_token: "deadbeef" },
    secretKey: "abcdefghij012345",
    params: "IFCAil8aSVa+gkEd/PXvlo2VA80YGlV59qu1mmD9mGOa94ec86/V3TCzny2CqLBnZRR2+ZJYVd90D3XwgRQHEu37l2wUTQ2KS/m4xWoHZ6d2nJzjgbQ5ZTfuEC88AAO/ueemAAXe+ovYZydVhpTtYsF/+p+meKG30aXaeMyT4Ge6rXcBsC3UkRl/nRGzyGYq",
    encSecKey: "b77979162b3d8f14a369119dbc4c7b378dd7716a4fa0c6ffed5eb1eb2d15caeba0df5b4904900970dc504c6120f6354d171a4b001a3bd43d46f419d41db44ab8526523d869048dbc1c43aaa7f87730436da0ac14c411961d15446d10910519d76b9be730fe18a02497b7eee0bf579dafd9d2520b8a3ebdcf01f55d61d6287e30"
};

test("黄金向量：固定 key 的 params 与 encSecKey 逐字节钉死（不依赖参考仓库）", async () => {
    const actual = await weapi.weapiEncrypt(GOLDEN.payload, GOLDEN.secretKey);
    assert.equal(actual.params, GOLDEN.params, "params 与黄金向量不一致");
    assert.equal(actual.encSecKey, GOLDEN.encSecKey, "encSecKey 与黄金向量不一致");
    // 再钉一层组合次序：第一层用 presetKey、第二层用 secretKey，反了这里就红。
    assert.equal(actual.params, referenceEncrypt(GOLDEN.payload, GOLDEN.secretKey).params);
});

test("params 与 Node AES-128-CBC 实现逐字节一致", async () => {
    const cases = [
        ["空对象", {}],
        ["单字段", { a: 1 }],
        ["真实载荷 csrf_token", { userLotteryId: "PRIVILEGE_ID_PLACEHOLDER", depositCode: "0", csrf_token: "deadbeef" }],
        ["中文与 emoji", { name: "黑胶乐签", note: "云贝直接充值到账 🎵", nested: { list: [1, 2, 3] } }],
        ["长载荷", { items: Array.from({ length: 120 }, (_, i) => ({ id: i, label: `任务 ${i}` })) }],
    ];

    for (const [label, payload] of cases) {
        const secretKey = "abcdefghij012345";
        const actual = await weapi.weapiEncrypt(payload, secretKey);
        assert.deepEqual(actual, referenceEncrypt(payload, secretKey), `${label} 不一致`);
    }
});

// 裸 RSA 的输出长度是概率性的：反序后的 16 字符当作大整数做 modPow，结果约 1/16 的概率只有 255 个 hex。
// 下面这个 key 是真实产物（自然长度 255），它把 padStart(256,"0") 从「恒为 no-op 的假守卫」变成必过的一关。
const SHORT_MODULUS_CASE = {
    secretKey: "KIMrMc25INuRZXOG",
    hex: "0e33e751870c2e16f1fe9e4dc0423e3a9df71d3d9dbfab620a62d86f1f0007b03604a794b0ec79c309ee2a95aa6ff32e991e576a77d379089fed7235ef5c7b8a7c523c70c6cb434a9e2896a5f56777f6bc3d9374d59585f944fb444c7864984719ca23d9a868090118406d43d83a1ca5260776aa9bf283c037dcff8dec851c21"
};

test("encSecKey 与 OpenSSL 裸 RSA(no padding) 一致且恒为 256 位 hex", async () => {
    for (const secretKey of ["abcdefghij012345", "0000000000000000", "zzzzzzzzzzzzzzzz", "aB3xY9qLm2Np7RsT", SHORT_MODULUS_CASE.secretKey]) {
        const { encSecKey } = await weapi.weapiEncrypt({}, secretKey);
        assert.match(encSecKey, /^[0-9a-f]{256}$/, `secretKey=${secretKey} 的 encSecKey 形态不对`);
        assert.equal(encSecKey, referenceEncrypt({}, secretKey).encSecKey);
    }
});

test("自然长度 255 的 key 被补零到 256，且与 OpenSSL 的补零结果一致", async () => {
    const unpadded = weapi.rsaNoPad([...SHORT_MODULUS_CASE.secretKey].reverse().join("")).replace(/^0+/, "");
    assert.equal(unpadded.length, 255, "夹具本身不再是 255 位自然长度，这条守卫就退化成假绿");
    assert.equal(weapi.rsaNoPad([...SHORT_MODULUS_CASE.secretKey].reverse().join("")), SHORT_MODULUS_CASE.hex);
    assert.equal(SHORT_MODULUS_CASE.hex, referenceEncrypt({}, SHORT_MODULUS_CASE.secretKey).encSecKey);
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

// 2000 次真实产物：既要断言补零后的 hex 恒 256，也要断言与 OpenSSL 一致，
// 这样 padStart 的阈值、模数、reverse 任何一处改动都会在这里现形。
test("2000 个随机 key 的 encSecKey 全为 256 hex 且与独立实现一致", async () => {
    let shortNatural = 0;
    for (const secretKey of Array.from({ length: 2000 }, () => weapi.randomSecretKey())) {
        const { encSecKey } = await weapi.weapiEncrypt({}, secretKey);
        assert.equal(encSecKey.length, 256, `secretKey=${secretKey} 产出了 ${encSecKey.length} 位 hex`);
        if (encSecKey[0] === "0") shortNatural++;
        assert.equal(encSecKey, referenceEncrypt({}, secretKey).encSecKey, `secretKey=${secretKey} 与独立实现不一致`);
    }
    assert.ok(shortNatural >= 64, `2000 次里只有 ${shortNatural} 次补零，随机源或夹具可疑`);
});

// 拒绝采样（丢弃 >= 248）的唯一可观测后果：62 个字符频率相同。阈值写坏就前 8 个字符偏置。
test("randomSecretKey 的 62 个字符频率均匀（拒绝采样在位）", () => {
    const counts = new Array(62).fill(0);
    for (let i = 0; i < 20000; i++) {
        for (const ch of weapi.randomSecretKey()) counts[weapi.BASE62.indexOf(ch)]++;
    }
    const spread = Math.max(...counts) - Math.min(...counts);
    assert.ok(spread <= 600, `62 桶极差 ${spread}，均匀性不成立（期望 < 600）`);
});

// 「一次一密」是随机 secretKey 的唯一收益；换成常量 key 后密文仍可解密，业务代码看不出差别，
// 所以这条断言是它唯一的守卫。
test("不带 fixedSecretKey 的两次加密产物必须互不相同", async () => {
    const payload = { n: 1, csrf_token: "deadbeef" };
    const a = await weapi.weapiEncrypt(payload);
    const b = await weapi.weapiEncrypt(payload);
    assert.notEqual(a.params, b.params, "params 两次相同，secretKey 没走随机源");
    assert.notEqual(a.encSecKey, b.encSecKey, "encSecKey 两次相同，secretKey 没走随机源");
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

// 把 crypto.getRandomValues 钉成全零 ⇒ secretKey 恒为 'a'×16，才能反解 weapiRequest 真正发出去的 body。
async function captureRequest(replyBody) {
    const realCrypto = globalThis.crypto;
    const realFetch = globalThis.fetch;
    let captured = null;
    Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: { subtle: realCrypto.subtle, getRandomValues: (buf) => buf.fill(0) }
    });
    globalThis.fetch = async (url, init) => {
        captured = { url: String(url), body: new URLSearchParams(String(init.body)) };
        return { ok: true, status: 200, json: async () => replyBody };
    };
    try {
        await weapi.weapiRequest("interface.music.163.com", "/weapi/pointmall/user/sign", {}, "TOKEN123");
    } finally {
        Object.defineProperty(globalThis, "crypto", { configurable: true, value: realCrypto });
        globalThis.fetch = realFetch;
    }
    return captured;
}

test("weapiRequest 把 csrf_token 一起塞进密文（服务端要密文内含），两层 AES 反解可得明文", async () => {
    const captured = await captureRequest({ code: 200, data: { sign: true } });
    assert.equal(captured.url, "https://interface.music.163.com/weapi/pointmall/user/sign?csrf_token=TOKEN123");

    const iv = Buffer.from("0102030405060708", "utf8");
    const aesCbcDecrypt = (key, data) => {
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
        return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    };
    const once = aesCbcDecrypt(Buffer.from("aaaaaaaaaaaaaaaa", "utf8"), captured.body.get("params"));
    const plaintext = JSON.parse(aesCbcDecrypt(Buffer.from("0CoJUm6Qyw8W8jud", "utf8"), once));
    assert.deepEqual(plaintext, { csrf_token: "TOKEN123" }, "密文明文不等于业务载荷 + csrf_token");
});

// 信封缺 code 会让调用方的 `code !== 200` 哨兵失效 ⇒ 必须在传输层就抛，交给上层按瞬态重试。
test("weapiRequest 在响应缺 code 时抛错，且错误文本只带 path 不带凭据", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: "degraded", data: null }) });
    try {
        await assert.rejects(
            () => weapi.weapiRequest("interface3.music.163.com", "/weapi/vip-center-bff/task/sign", {}, "TOKEN123"),
            (err) => {
                assert.match(err.message, /响应缺少 code 字段 \/weapi\/vip-center-bff\/task\/sign/);
                assert.ok(!err.message.includes("TOKEN123"), "错误文本不得带出 csrf_token");
                return true;
            }
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});
