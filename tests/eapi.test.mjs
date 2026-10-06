// eapi 加密层离线测试：MD5 / AES-128-ECB / EAPI 装配 —— 全部与 Node 内置实现逐字节比对，不联网、不碰 chrome.*。
// 跑法：node --test（仓库根目录）
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const eapi = require2(path.join(HERE, "..", "eapi.js"));

const EAPI_KEY_TEXT = "e82ckenh8dichen8";

test("md5Hex 与 Node 内置实现一致（含填充边界与中文）", () => {
    const cases = [
        "",
        "abc",
        "The quick brown fox jumps over the lazy dog",
        "nobody/api/vip-center-bff/task/signuse{}md5forencrypt",
        "你好，网易云音乐",
        "x".repeat(55),
        "x".repeat(56),
        "x".repeat(63),
        "x".repeat(64),
        "x".repeat(1000)
    ];
    for (const text of cases) {
        assert.equal(
            eapi.md5Hex(text),
            crypto.createHash("md5").update(text, "utf8").digest("hex"),
            `md5 不一致：len=${text.length}`
        );
    }
});

test("aesEcb 加解密与 Node 实现逐字节一致且可往返", () => {
    const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const nodeEncrypt = (bytes) => {
        const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
        return Buffer.concat([cipher.update(bytes), cipher.final()]);
    };

    // FIPS-197 附录 B 单块向量（PKCS#7 补齐后比对首块）
    const fipsPlain = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const fipsEncrypted = Buffer.from(eapi.aesEcbEncrypt(key, fipsPlain));
    assert.equal(fipsEncrypted.subarray(0, 16).toString("hex"), "69c4e0d86a7b0430d8cdb78070b4c55a");

    // 整块/多块/随机长度往返 + 与 Node 逐字节比对
    for (const bytes of [
        Buffer.alloc(16, 0x00),
        Buffer.alloc(16, 0x10),
        Buffer.alloc(16, 0xff),
        crypto.randomBytes(1),
        crypto.randomBytes(15),
        crypto.randomBytes(16),
        crypto.randomBytes(777)
    ]) {
        const mine = Buffer.from(eapi.aesEcbEncrypt(key, bytes));
        assert.equal(mine.toString("hex"), nodeEncrypt(bytes).toString("hex"), `加密不一致：len=${bytes.length}`);
        assert.deepEqual(Buffer.from(eapi.aesEcbDecrypt(key, mine)), bytes, `往返失败：len=${bytes.length}`);
    }
});

test("eapiParamsHex 与独立实现一致（固定黄金向量）", () => {
    const apiPath = "/api/vip-center-bff/task/sign";
    const payload = { e_r: true, header: "{}" };

    // 独立实现：Node 内置 MD5 + AES-128-ECB
    const text = JSON.stringify(payload);
    const digest = crypto.createHash("md5").update(`nobody${apiPath}use${text}md5forencrypt`).digest("hex");
    const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(EAPI_KEY_TEXT), null);
    const expected = Buffer.concat([cipher.update(Buffer.from(data, "utf8")), cipher.final()]).toString("hex").toUpperCase();

    const actual = eapi.eapiParamsHex(apiPath, payload);
    assert.equal(actual, expected);
    assert.equal(actual, "20A9F83535AEAF56CF305325A0FB02169FE5D0F52B96C382A9048F4CC4BF7A63E6415238B738285C2BC831A756C18AC0755B380F2BE46E25CB1FB3F6DE5F47DD408C99E5D770163DEBA75853835417AA48ABA4B27E45EAA41E4001B26382E0514AD7821BE91D292ABBBB36E9E313D704D42659F0BF29A1C25844DB59AFB57876",
        "黄金向量变了：要么实现改了，要么接口装配改了，改前先想清楚");
});

test("eapiDecryptResponse 能解开 gzip 的加密响应", async () => {
    const json = JSON.stringify({ code: 200, data: true, message: "" });
    const gzipped = zlib.gzipSync(Buffer.from(json, "utf8"));
    const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(EAPI_KEY_TEXT), null);
    const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()]);

    const decoded = await eapi.eapiDecryptResponse(new Uint8Array(encrypted));
    assert.deepEqual(decoded, { code: 200, data: true, message: "" });
});
