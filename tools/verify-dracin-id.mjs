#!/usr/bin/env node
/**
 * End-to-end verification of the dracin-id Sansekai adapters WITHOUT the
 * dev-server's per-request cache-busting (which would defeat the in-memory
 * cache and blow the ~10 req/min upstream rate limit).
 *
 * Imports the route module ONCE so the module-level _cache persists across
 * list -> detail -> episode calls, then drives the HTTP handler directly.
 * Spacing between sources keeps us under the upstream rate limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// Load .env.local
const env = fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n');
for (const l of env) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { default: handler } = await import(pathToFileURL(path.join(root, 'api/dracin-id.js')).href);

function call(query) {
    return new Promise((resolve, reject) => {
        const req = {
            query,
            headers: { cookie: '__Host-nonthon_sess=' + process.env.TEST_TOKEN },
        };
        const res = {
            _status: 200,
            _headers: {},
            status(c) { this._status = c; return this; },
            setHeader(k, v) { this._headers[k] = v; return this; },
            json(obj) { resolve({ status: this._status, body: obj }); },
            end() { resolve({ status: this._status, body: null }); },
        };
        handler(req, res).catch(reject);
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SOURCES = ['reelshort', 'dramabox', 'shortmax', 'pinedrama', 'netshort', 'freereels'];
let failures = 0;

for (const src of SOURCES) {
    console.log(`\n========== ${src} ==========`);
    try {
        const lr = await call({ action: 'list', source: src, page: 1 });
        const items = lr.body?.items || [];
        console.log(`list: HTTP ${lr.status}, ${items.length} items`);
        if (lr.status !== 200 || !items.length) {
            console.log(`  !! ${lr.body?.error || lr.body?.detail || 'no items'}`);
            if (lr.status === 429) { console.log('  rate-limited; waiting 25s'); await sleep(25000); }
            failures++;
            continue;
        }
        const it = items[0];
        console.log(`  first: "${it.title}" id=${it.id} eps=${it.episodes} pic=${it.pic ? 'yes' : 'NO'}`);
        if (!it.pic) failures++;

        // detail
        await sleep(4000);
        const dr = await call({ action: 'detail', source: src, id: it.id });
        const item = dr.body?.item;
        const epList = item?.epList || [];
        console.log(`detail: HTTP ${dr.status}, ${epList.length} eps, title="${item?.title}"`);
        if (dr.status !== 200 || !epList.length) { failures++; continue; }

        // episode (first + last)
        for (const ep of [epList[0].ep, epList[epList.length - 1].ep]) {
            await sleep(4000);
            const er = await call({ action: 'episode', source: src, id: it.id, ep: String(ep) });
            const url = er.body?.url || '';
            const playable = /\.(m3u8|mp4)(\?|$)/i.test(url) || /^https?:\/\//.test(url);
            console.log(`  ep ${ep}: HTTP ${er.status} url=${url ? url.slice(0, 90) : 'NONE'} playable=${playable}`);
            if (er.status !== 200 || !playable) failures++;
        }
    } catch (e) {
        console.log('  EXCEPTION: ' + e.message);
        failures++;
    }
    await sleep(4000);
}

console.log(failures === 0 ? '\nALL SOURCES VERIFIED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
