/**
 * NXRStream web API crypto module.
 *
 * Generates the signed/encrypted headers required by api.loklok.fun and
 * decrypts encrypted response bodies. Uses only Node.js built-in `crypto`.
 *
 * Crypto flow (extracted from NXRStream's frontend JS bundle):
 * 1. Random 16-byte AES key (hex string) per request
 * 2. aesKey header = RSA PKCS1-v1.5 encrypt(aesKey, publicKey) → base64
 * 3. sign = MD5(AES_ECB_encrypt(queryString + timestamp, aesKey) + aesKey)
 * 4. usertype = HMAC_SHA256(deviceId,
 *      AES_ECB_encrypt(aesKey, first16BytesOfPublicKeyModulus))
 * 5. Response: if header ecy=1, data is AES-ECB encrypted → decrypt with aesKey
 */
import crypto from 'node:crypto';

// RSA public key (extracted from NXRStream's JS bundle, variable `lT`)
const PUBLIC_KEY_PEM = [
    '-----BEGIN PUBLIC KEY-----',
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCR0hi0Ah2EkHEL0bMsyQUPn8A1',
    '0ZW42z9LtfSiUSMaf3lw/sfqRcMTmh4m8+sBnK2a5PWKLTG2CW/HWYydN5n1BU63',
    'c9yYMAoUD+52usxxsMaELLOb+xEv6LRW5oquDck7ZWj0xkSfHc4UXUa1l1FwVXQS',
    '+qFIRDJGXgPCUEGVmwIDAQAB',
    '-----END PUBLIC KEY-----',
].join('\n');

// First 16 characters of the base64-encoded public key DER (without PEM markers).
// In the JS: `dT(publicKey).slice(0, 16)` where dT strips PEM markers + whitespace.
// The result is a 16-char ASCII string whose UTF-8 bytes become the AES key.
const PUBLIC_KEY_B64_STRIPPED = PUBLIC_KEY_PEM
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
const USERTYPE_AES_KEY_STRING = PUBLIC_KEY_B64_STRIPPED.slice(0, 16); // "MIGfMA0GCSqGSIb3"
const USERTYPE_AES_KEY_HEX = Buffer.from(USERTYPE_AES_KEY_STRING, 'utf8').toString('hex');
// USERTYPE_AES_KEY_HEX is the hex representation, but we pass the raw string to aesEcbEncrypt
// which treats it as UTF-8 bytes. So we actually use USERTYPE_AES_KEY_STRING directly.

/** Generate a random hex string of n chars (not n bytes!). */
function randomHex(len) {
    const bytes = crypto.randomBytes(Math.ceil(len / 2));
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

/** Generate a persistent device ID (32-char uppercase hex). */
export function getDeviceId() {
    return randomHex(16).toUpperCase();
}

/**
 * AES-128-ECB encrypt with PKCS7 padding → base64.
 * The "key" is a 16-char hex string used as UTF-8 bytes (not decoded as hex).
 * This matches the JS implementation where Cn(t) = TextEncoder.encode(keyString).
 */
function aesEcbEncrypt(plaintext, keyString) {
    const key = Buffer.from(keyString, 'utf8'); // 16-char hex string as UTF-8 bytes = 16 bytes
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(true); // PKCS7
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return encrypted.toString('base64');
}

/**
 * AES-128-ECB decrypt from base64 → string.
 * The "key" is a 16-char hex string used as UTF-8 bytes.
 */
function aesEcbDecrypt(ciphertextB64, keyString) {
    const key = Buffer.from(keyString, 'utf8');
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64')),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}

/** RSA PKCS#1 v1.5 encrypt → base64. */
function rsaEncrypt(plaintext, publicKeyPem) {
    const encrypted = crypto.publicEncrypt(
        { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(plaintext, 'utf8'),
    );
    return encrypted.toString('base64');
}

/** MD5 hash → lowercase hex. */
function md5(input) {
    return crypto.createHash('md5').update(input).digest('hex');
}

/** HMAC-SHA256(key, data) → lowercase hex. */
function hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Build the canonical query string from request params.
 * For GET: sort keys alphabetically, concatenate raw values (no URL encoding).
 * For POST: serialize the JSON body to a canonical string.
 *
 * This matches the ET() function in NXRStream's JS:
 *   Object.keys(params).sort().map(k => params[k]).filter(Boolean).join("")
 * Where Boolean("0") is true (non-empty string), so "0" is kept.
 */
function buildQueryString(params) {
    if (!params || typeof params !== 'object') return '';
    return Object.keys(params).sort()
        .map(k => {
            const v = params[k];
            if (v == null) return '';
            return String(v);
        })
        .filter(Boolean)
        .join('');
}

/**
 * Serialize a JSON body to the canonical string used for signing.
 * This matches the `oc()` function in NXRStream's JS:
 * - sort keys, for each key: if string use raw value, if array join items,
 *   if object recurse, else JSON.stringify. No URL encoding.
 */
function canonicalSerialize(obj) {
    if (obj == null) return '';
    if (typeof obj === 'string') {
        try {
            return canonicalSerialize(JSON.parse(obj));
        } catch {
            return '';
        }
    }
    if (typeof obj !== 'object' || Array.isArray(obj)) return '';

    return Object.keys(obj).sort().map(k => {
        const v = obj[k];
        if (typeof v === 'string') {
            return v || '';
        }
        if (Array.isArray(v)) {
            return v.map(item =>
                typeof item === 'string' ? (item || '') :
                typeof item === 'object' && item ? canonicalSerialize(item) :
                JSON.stringify(item)
            ).join('');
        }
        if (typeof v === 'object' && v) return canonicalSerialize(v);
        return JSON.stringify(v);
    }).join('');
}

/**
 * Generate all headers needed for an api.loklok.fun request.
 *
 * @param {Object|null} query - URL query params (for GET)
 * @param {Object|null} body - request body (for POST)
 * @param {string|null} cookieHeader - raw cookie header string
 * @param {string} deviceId - persistent device ID
 * @returns {Object} headers object including aesKey_Internal (for decryption)
 */
export async function generateHeaders(query, body, cookieHeader, deviceId) {
    const aesKey = randomHex(16); // random 16-byte AES key as hex (32 chars)
    const timestamp = String(Date.now());

    // RSA encrypt the AES key
    const aesKeyHeader = rsaEncrypt(aesKey, PUBLIC_KEY_PEM);

    // Build sign:
    // 1. Build query string from params or body (no URL encoding, raw values)
    // 2. Concatenate queryString + timestamp
    // 3. AES-ECB encrypt → base64
    // 4. MD5(encryptedBase64) → lowercase hex (NOT encrypted + aesKey!)
    let queryString;
    if (body) {
        queryString = canonicalSerialize(body);
    } else {
        queryString = buildQueryString(query);
    }

    const toEncrypt = queryString + timestamp;
    const encrypted = aesEcbEncrypt(toEncrypt, aesKey);
    const sign = md5(encrypted);

    // Build usertype:
    // CT(deviceId, aesKey, modulusKey) =>
    //   Am(deviceId, modulusKey) → AES_ECB_encrypt(deviceId, modulusKey) → base64
    //   aT(aesEncrypted, aesKey) → HMAC_SHA256(key=aesKey, data=aesEncrypted) → hex
    const userTypeEncrypted = aesEcbEncrypt(deviceId, USERTYPE_AES_KEY_STRING);
    const usertype = hmacSha256(aesKey, userTypeEncrypted);

    // Get timezone
    const offset = -new Date().getTimezoneOffset();
    const sign2 = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const tz = `GMT${sign2}${String(Math.floor(absOffset / 60)).padStart(2, '0')}:${String(absOffset % 60).padStart(2, '0')}`;

    // Get lang from cookie or default
    let lang = 'en';
    if (cookieHeader) {
        const match = cookieHeader.match(/loklok_locale=([^;]+)/);
        if (match) lang = decodeURIComponent(match[1]);
    }

    // Get token from cookie if present
    let token = '';
    if (cookieHeader) {
        const match = cookieHeader.match(/loklok_token=([^;]+)/);
        if (match) token = decodeURIComponent(match[1]);
    }

    const headers = {
        'Content-Type': 'application/json',
        aesKey: aesKeyHeader,
        aesKey_Internal: aesKey,
        clientType: 'web-loklok',
        currentTime: timestamp,
        deviceId,
        keke: 'false',
        lang,
        sign,
        timezone: tz,
        versionCode: '32',
    };

    if (token) headers.token = token;
    headers.usertype = usertype;

    return headers;
}

/**
 * Decrypt an encrypted response data field.
 *
 * @param {string} encryptedBase64 - the encrypted data string
 * @param {string} aesKeyInternal - the hex AES key used for this request
 * @returns {Object} the decrypted JSON object
 */
export function decryptResponse(encryptedBase64, aesKeyInternal) {
    const decrypted = aesEcbDecrypt(encryptedBase64, aesKeyInternal);
    return JSON.parse(decrypted);
}