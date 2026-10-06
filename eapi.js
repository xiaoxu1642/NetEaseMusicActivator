// eapi 协议层：乐签「打卡」只认客户端形态的 eapi 请求（2026-10-06 实测）。
// weapi 版的 vip-center-bff/task/sign 会返回 data:true 但服务端并不落签，属于假成功，
// 所以打卡改走 eapi：AES-128-ECB(hex 大写) + MD5 摘要 + 加密响应（x-aeapi）。
// 算法与常量对齐参考实现 netease-cloud-music-master/pkg/crypto/crypto.go 的 EApiEncrypt/EApiDecrypt。
// 本文件不引用任何 chrome.* API，以便在 Node 下直接跑离线等价测试。

const EAPI_KEY = new TextEncoder().encode("e82ckenh8dichen8");

// ---- MD5（RFC 1321，WebCrypto 不提供 MD5） ----

const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

const MD5_SHIFT = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

function md5Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const bitLen = bytes.length * 8;

    const padLen = (bytes.length + 1) % 64 <= 56 ? 56 - (bytes.length + 1) % 64 : 120 - (bytes.length + 1) % 64;
    const padded = new Uint8Array(bytes.length + 1 + padLen + 8);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bitLen >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476;
    const m = new Uint32Array(16);

    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            const p = off + i * 4;
            m[i] = padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
        }

        let a = h0, b = h1, c = h2, d = h3;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }

            const sum = (a + f + MD5_K[i] + m[g]) | 0;
            const rotated = (sum << MD5_SHIFT[i]) | (sum >>> (32 - MD5_SHIFT[i]));
            const prevD = d;
            d = c;
            c = b;
            b = (b + rotated) | 0;
            a = prevD;
        }

        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
    }

    return [h0, h1, h2, h3]
        .map((word) => [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0")).join(""))
        .join("");
}

// ---- AES-128-ECB + PKCS#7（WebCrypto 不支持 ECB，查表实现以固定输出便于离线比对） ----

const AES_EXP = new Uint8Array(255);
const AES_LOG = new Uint8Array(256);
const AES_SBOX = new Uint8Array(256);
const AES_INV_SBOX = new Uint8Array(256);

(function buildAesTables() {
    const xtime = (b) => ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff;
    const rotl8 = (b, n) => ((b << n) | (b >> (8 - n))) & 0xff;

    // exp/log 以生成元 3 构建 GF(2^8) 乘法表
    let x = 1;
    for (let i = 0; i < 255; i++) {
        AES_EXP[i] = x;
        AES_LOG[x] = i;
        x = xtime(x) ^ x;
    }

    for (let b = 0; b < 256; b++) {
        const inverse = b ? AES_EXP[(255 - AES_LOG[b]) % 255] : 0;
        const s = inverse ^ rotl8(inverse, 1) ^ rotl8(inverse, 2) ^ rotl8(inverse, 3) ^ rotl8(inverse, 4) ^ 0x63;
        AES_SBOX[b] = s;
        AES_INV_SBOX[s] = b;
    }
})();

function gmul(a, b) {
    return (a && b) ? AES_EXP[(AES_LOG[a] + AES_LOG[b]) % 255] : 0;
}

function aesExpandKey(key) {
    const rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
    const w = new Uint8Array(176);
    w.set(key, 0);
    for (let i = 16; i < 176; i += 4) {
        let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
        if (i % 16 === 0) {
            const first = t0;
            t0 = AES_SBOX[t1] ^ rcon[i / 16 - 1];
            t1 = AES_SBOX[t2];
            t2 = AES_SBOX[t3];
            t3 = AES_SBOX[first];
        }
        w[i] = w[i - 16] ^ t0;
        w[i + 1] = w[i - 15] ^ t1;
        w[i + 2] = w[i - 14] ^ t2;
        w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
}

function addRoundKey(s, w, round) {
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
}

// 以下状态按列优先线性布局：字节 i 位于第 (i%4) 行、第 floor(i/4) 列
function shiftRows(s) {
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = t;
}

function invShiftRows(s) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
}

function mixColumns(s) {
    const xtime = (b) => ((b << 1) ^ ((b & 0x80) ? 0x1b : 0)) & 0xff;
    for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        const t = a0 ^ a1 ^ a2 ^ a3;
        s[c] = a0 ^ t ^ xtime(a0 ^ a1);
        s[c + 1] = a1 ^ t ^ xtime(a1 ^ a2);
        s[c + 2] = a2 ^ t ^ xtime(a2 ^ a3);
        s[c + 3] = a3 ^ t ^ xtime(a3 ^ a0);
    }
}

function invMixColumns(s) {
    for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        s[c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
}

function aesEncryptBlock(s, w) {
    addRoundKey(s, w, 0);
    for (let round = 1; round < 10; round++) {
        for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
        shiftRows(s);
        mixColumns(s);
        addRoundKey(s, w, round);
    }
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    shiftRows(s);
    addRoundKey(s, w, 10);
}

function aesDecryptBlock(s, w) {
    addRoundKey(s, w, 10);
    for (let round = 9; round >= 1; round--) {
        invShiftRows(s);
        for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
        addRoundKey(s, w, round);
        invMixColumns(s);
    }
    invShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
    addRoundKey(s, w, 0);
}

function pkcs7Pad(bytes) {
    const padLen = 16 - (bytes.length % 16);
    const out = new Uint8Array(bytes.length + padLen);
    out.set(bytes);
    out.fill(padLen, bytes.length);
    return out;
}

function pkcs7Unpad(bytes) {
    const padLen = bytes[bytes.length - 1];
    if (padLen < 1 || padLen > 16 || padLen > bytes.length) throw new Error("PKCS#7 填充非法");
    for (let i = bytes.length - padLen; i < bytes.length; i++) {
        if (bytes[i] !== padLen) throw new Error("PKCS#7 填充非法");
    }
    return bytes.subarray(0, bytes.length - padLen);
}

function aesEcbEncrypt(keyBytes, plainBytes) {
    const w = aesExpandKey(keyBytes);
    const padded = pkcs7Pad(plainBytes);
    const out = new Uint8Array(padded.length);
    for (let off = 0; off < padded.length; off += 16) {
        const block = padded.slice(off, off + 16);
        aesEncryptBlock(block, w);
        out.set(block, off);
    }
    return out;
}

function aesEcbDecrypt(keyBytes, cipherBytes) {
    const w = aesExpandKey(keyBytes);
    const out = new Uint8Array(cipherBytes.length);
    for (let off = 0; off < cipherBytes.length; off += 16) {
        const block = cipherBytes.slice(off, off + 16);
        aesDecryptBlock(block, w);
        out.set(block, off);
    }
    return pkcs7Unpad(out);
}

// ---- EAPI 装配（message 摘要用 /api/... 形态，与官方客户端抓包一致） ----

function bytesToHexUpper(bytes) {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out.toUpperCase();
}

// apiPath 形如 "/api/vip-center-bff/task/sign"（服务端要求摘要里用 api 而非 eapi）
function eapiParamsHex(apiPath, payload) {
    const text = JSON.stringify(payload);
    const digest = md5Hex(`nobody${apiPath}use${text}md5forencrypt`);
    const data = `${apiPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
    return bytesToHexUpper(aesEcbEncrypt(EAPI_KEY, new TextEncoder().encode(data)));
}

async function gunzipBytes(bytes) {
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 打卡响应是 ECB 密文（内容为 gzip 后的 JSON），带 x-aeapi 时才是这个形态
async function eapiDecryptResponse(cipherBytes) {
    const plain = aesEcbDecrypt(EAPI_KEY, cipherBytes);
    const bytes = plain[0] === 0x1f && plain[1] === 0x8b ? await gunzipBytes(plain) : plain;
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function eapiRequest(host, apiPath, payload) {
    const response = await fetch(`https://${host}/eapi/${apiPath.slice(5)}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-aeapi": "true"
        },
        credentials: "include",
        body: new URLSearchParams({ params: eapiParamsHex(apiPath, payload) })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${apiPath}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x7b) return JSON.parse(new TextDecoder().decode(bytes));
    return eapiDecryptResponse(bytes);
}

// 被 importScripts 加载时这些声明落在全局词法作用域，background.js 直接可见；
// 被 Node require 时走这个导出分支。
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        EAPI_KEY,
        AES_SBOX,
        AES_INV_SBOX,
        md5Hex,
        aesEcbEncrypt,
        aesEcbDecrypt,
        eapiParamsHex,
        eapiDecryptResponse,
        eapiRequest
    };
}
