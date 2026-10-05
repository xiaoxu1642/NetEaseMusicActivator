// weapi 协议层：算法与常量对齐 NeteaseMusic-API-main/util/crypto.js 与
// netease-cloud-music-master/pkg/crypto/crypto.go，改前先读 PLAN-signin-vip.md §5.2。
// 本文件不引用任何 chrome.* API，以便在 Node 下直接跑离线等价测试。

const WEAPI_IV = new TextEncoder().encode("0102030405060708");
const WEAPI_PRESET_KEY = new TextEncoder().encode("0CoJUm6Qyw8W8jud");
const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// 官方公钥的 1024 位模数。裸 RSA(no padding) 的输出必须左补零到 128 字节 = 256 个 hex 字符，
// 少一位服务端就解不出来，所以这里用 BigInt 常量而不是让实现去解析 PEM。
const WEAPI_RSA_MODULUS = 0xe0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7n;
const WEAPI_RSA_EXPONENT = 65537n;

function bytesToBase64(buffer) {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
}

async function aesCbcEncryptToBase64(keyBytes, plaintext) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
    const cipher = await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: WEAPI_IV },
        key,
        new TextEncoder().encode(plaintext)
    );
    return bytesToBase64(cipher);
}

// 256 不整除 62，直接取模会让前 62 个字符概率偏高，所以丢弃 >= 248 的字节。
function randomSecretKey() {
    const chars = [];
    const pool = new Uint8Array(64);
    while (chars.length < 16) {
        crypto.getRandomValues(pool);
        for (const byte of pool) {
            if (byte < 248) chars.push(BASE62[byte % 62]);
            if (chars.length === 16) break;
        }
    }
    return chars.join("");
}

function modPow(base, exponent, modulus) {
    let result = 1n;
    base %= modulus;
    while (exponent > 0n) {
        if (exponent & 1n) result = (result * base) % modulus;
        base = (base * base) % modulus;
        exponent >>= 1n;
    }
    return result;
}

function rsaNoPad(asciiText) {
    let value = 0n;
    for (const ch of asciiText) value = (value << 8n) | BigInt(ch.charCodeAt(0));
    return modPow(value, WEAPI_RSA_EXPONENT, WEAPI_RSA_MODULUS).toString(16).padStart(256, "0");
}

// fixedSecretKey 只给离线等价测试用，业务代码不要传第二个参数。
async function weapiEncrypt(payload, fixedSecretKey) {
    const secretKey = fixedSecretKey || randomSecretKey();
    const once = await aesCbcEncryptToBase64(WEAPI_PRESET_KEY, JSON.stringify(payload));
    const params = await aesCbcEncryptToBase64(new TextEncoder().encode(secretKey), once);
    return { params, encSecKey: rsaNoPad([...secretKey].reverse().join("")) };
}

async function weapiRequest(host, path, data, csrfToken, query) {
    const { params, encSecKey } = await weapiEncrypt({ ...data, csrf_token: csrfToken });
    const url = new URL(`https://${host}${path}`);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    url.searchParams.set("csrf_token", csrfToken || "");

    const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "include",
        body: new URLSearchParams({ params, encSecKey }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);

    const json = await response.json().catch(() => {
        throw new Error(`响应不是 JSON ${path}`);
    });
    return json;
}

// 被 importScripts 加载时这些声明落在全局词法作用域，background.js 直接可见；
// 被 Node require 时走这个导出分支。
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        WEAPI_IV,
        WEAPI_PRESET_KEY,
        BASE62,
        WEAPI_RSA_MODULUS,
        WEAPI_RSA_EXPONENT,
        randomSecretKey,
        rsaNoPad,
        modPow,
        weapiEncrypt,
        weapiRequest,
    };
}
