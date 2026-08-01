#!/usr/bin/env node
/**
 * Derive ACCESS_HASHES from plaintext passwords.
 *
 * Usage:
 *   AUTH_SECRET=<hex> node tools/hash-password.mjs "pass one" "pass two"
 *
 * Prints only hashes. Plaintext is never written to disk by this script.
 */
import crypto from 'node:crypto';

const secret = process.env.AUTH_SECRET;
if (!secret || secret.length < 32) {
    console.error('AUTH_SECRET missing or too short (need >=32 chars).');
    process.exit(1);
}

const passwords = process.argv.slice(2);
if (passwords.length === 0) {
    console.error('Usage: AUTH_SECRET=<hex> node tools/hash-password.mjs "pass1" "pass2" ...');
    process.exit(1);
}

const hashes = passwords.map(p =>
    crypto.createHash('sha256').update(secret + p).digest('hex')
);

console.log('ACCESS_HASHES=' + hashes.join(','));
