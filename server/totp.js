// server/totp.js
// Simple TOTP (Time-based One-Time Password) implementation
// RFC 6238 compliant - 30 second intervals, 6 digits, HMAC-SHA1

import crypto from "crypto";

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encode a Buffer to Base32 string
 * @param {Buffer} buffer - The buffer to encode
 * @returns {string} Base32 encoded string
 */
export function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = "";

    for (let i = 0; i < buffer.length; i++) {
        value = (value << 8) | buffer[i];
        bits += 8;

        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
}

/**
 * Decode a Base32 string to Buffer
 * @param {string} str - Base32 encoded string
 * @returns {Buffer} Decoded buffer
 */
export function base32Decode(str) {
    // Remove padding and convert to uppercase
    const input = str.replace(/=+$/, "").toUpperCase();

    let bits = 0;
    let value = 0;
    const output = [];

    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const idx = BASE32_ALPHABET.indexOf(char);

        if (idx === -1) {
            throw new Error(`Invalid base32 character: ${char}`);
        }

        value = (value << 5) | idx;
        bits += 5;

        if (bits >= 8) {
            output.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }

    return Buffer.from(output);
}

/**
 * Generate a random TOTP secret
 * @param {number} length - Length of the secret in bytes (default: 20 for 160 bits)
 * @returns {string} Base32 encoded secret
 */
export function generateSecret(length = 20) {
    const buffer = crypto.randomBytes(length);
    return base32Encode(buffer);
}

/**
 * Generate TOTP code for a given secret and time
 * @param {string} secret - Base32 encoded secret
 * @param {number} counter - The time counter (floor(unixTime / 30))
 * @returns {string} 6-digit OTP code
 */
export function generateTOTP(secret, counter) {
    // Decode the base32 secret
    const key = base32Decode(secret);

    // Convert counter to 8-byte big-endian buffer
    const counterBuffer = Buffer.alloc(8);
    // Write as big-endian 64-bit integer
    // JavaScript numbers can safely represent integers up to 2^53 - 1
    const high = Math.floor(counter / 0x100000000);
    const low = counter % 0x100000000;
    counterBuffer.writeUInt32BE(high, 0);
    counterBuffer.writeUInt32BE(low >>> 0, 4);

    // Generate HMAC-SHA1
    const hmac = crypto.createHmac("sha1", key);
    hmac.update(counterBuffer);
    const hash = hmac.digest();

    // Dynamic truncation (RFC 4226)
    const offset = hash[hash.length - 1] & 0x0f;
    const binary =
        ((hash[offset] & 0x7f) << 24) |
        ((hash[offset + 1] & 0xff) << 16) |
        ((hash[offset + 2] & 0xff) << 8) |
        (hash[offset + 3] & 0xff);

    // Generate 6-digit code
    const otp = binary % 1000000;

    // Pad with leading zeros if necessary
    return otp.toString().padStart(6, "0");
}

/**
 * Get the current time counter
 * @param {number} timestamp - Unix timestamp in milliseconds (default: Date.now())
 * @param {number} period - Time period in seconds (default: 30)
 * @returns {number} Time counter
 */
export function getTimeCounter(timestamp = Date.now(), period = 30) {
    return Math.floor(timestamp / 1000 / period);
}

/**
 * Verify a TOTP code
 * Accepts codes from adjacent time windows to handle time drift
 * @param {string} secret - Base32 encoded secret
 * @param {string} code - The OTP code to verify
 * @param {number} window - Number of time periods to check before and after current (default: 1)
 * @returns {boolean} True if the code is valid
 */
export function verifyTOTP(secret, code, window = 1) {
    if (!secret || !code) {
        return false;
    }

    // Normalize the code (remove spaces, ensure 6 digits)
    const normalizedCode = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(normalizedCode)) {
        return false;
    }

    const currentCounter = getTimeCounter();

    // Check codes within the time window
    for (let i = -window; i <= window; i++) {
        const expectedCode = generateTOTP(secret, currentCounter + i);

        // Use constant-time comparison to prevent timing attacks
        if (constantTimeEqual(normalizedCode, expectedCode)) {
            return true;
        }
    }

    return false;
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function constantTimeEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
}

/**
 * Generate an otpauth:// URI for authenticator apps
 * @param {string} email - User's email address
 * @param {string} secret - Base32 encoded secret
 * @param {string} issuer - Application name (default: "DeliveryApp")
 * @returns {string} otpauth:// URI
 */
export function generateOTPAuthURI(email, secret, issuer = "DeliveryApp") {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedEmail = encodeURIComponent(email);
    const label = `${encodedIssuer}:${encodedEmail}`;

    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodedIssuer}`;
}

/**
 * Generate current TOTP code for testing purposes
 * @param {string} secret - Base32 encoded secret
 * @returns {string} Current 6-digit OTP code
 */
export function getCurrentTOTP(secret) {
    const counter = getTimeCounter();
    return generateTOTP(secret, counter);
}
