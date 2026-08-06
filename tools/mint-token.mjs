#!/usr/bin/env node
// Mint a fresh TEST_TOKEN into .env.local (12h TTL) and print it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');
const env = fs.readFileSync(envPath, 'utf8').split('\n');
for (const l of env) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { issueToken, verifyToken } = await import(pathToFileURL(path.join(root, 'lib/auth.js')).href);
const t = issueToken();
console.log('valid=' + verifyToken(t));
let txt = fs.readFileSync(envPath, 'utf8');
txt = txt.replace(/^TEST_TOKEN=.*$/m, 'TEST_TOKEN=' + t);
fs.writeFileSync(envPath, txt);
console.log('TOKEN=' + t);
