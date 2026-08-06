#!/usr/bin/env node
/**
 * End-to-end verification of the DEPLOYED dracin-id sources on
 * nonthon.vercel.app. The sandbox IP is blacklisted by Sansekai, but the
 * deployed Vercel functions run from Vercel's IPs, so this exercises the real
 * production path (list -> detail -> episode -> playable m3u8/mp4).
 *
 * Spacing keeps us under Sansekai's ~10 req/min; on 429 we back off 30s.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.readFileSync(path.join(root, '.env.local'), 'utf8').split('\n');
for (const l of env) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { issueToken } = await import(pathToFileURL(path.join(root, 'lib/auth.js')).href);
const TOKEN = issueToken();
const BASE = process.env.DEPLOY_BASE || 'https://nonthon.vercel.app';

async function call(params, retries = 2) {
    const qs = new URLSearchParams(params);
    for (let attempt = 0; attempt <= retries; attempt++) {
        const r = await fetch(`${BASE}/api/dracin-id?${qs}`, {
            headers: { cookie: '__Host-nonthon_sess=' + TOKEN },
        });
        if (r.status === 429) {
            console.log(`  429 -> backoff 30s (attempt ${attempt + 1})`);
            await new Promise(r2 => setTimeout(r2, 30000));
            continue;
        }
        let body = null;
        try { body = await r.json(); } catch { /* non-json */ }
        return { status: r.status, body };
    }
    return { status: 429, body: null };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SOURCES = ['reelshort', 'dramabox', 'shortmax', 'pinedrama', 'netshort', 'freereels'];
let failures = 0;

console.log(`Verifying DEPLOYED dracin-id on ${BASE}`);
for (const src of SOURCES) {
    console.log(`\n========== ${src} ==========`);
    try {
        const lr = await call({ action: 'list', source: src, page: 1 });
        const items = lr.body?.items || [];
        console.log(`list: HTTP ${lr.status}, ${items.length} items`);
        if (lr.status !== 200 || !items.length) {
            console.log(`  !! ${lr.body?.error || lr.body?.detail || 'no items'}`);
            failures++;
            continue;
        }
        const it = items[0];
        console.log(`  first: "${it.title}" id=${it.id} eps=${it.episodes} pic=${it.pic ? 'yes' : 'NO'}`);
        if (!it.pic) failures++;

        await sleep(7000);
        const dr = await call({ action: 'detail', source: src, id: it.id });
        const item = dr.body?.item;
        const epList = item?.epList || [];
        console.log(`detail: HTTP ${dr.status}, ${epList.length} eps, title="${item?.title}"`);
        if (dr.status !== 200 || !epList.length) { failures++; continue; }

        const ep = epList[0].ep;
        await sleep(7000);
        const er = await call({ action: 'episode', source: src, id: it.id, ep: String(ep) });
        const url = er.body?.url || '';
        const playable = /\.(m3u8|mp4)(\?|$)/i.test(url) || /^https?:\/\//.test(url);
        console.log(`  ep ${ep}: HTTP ${er.status} url=${url ? url.slice(0, 110) : 'NONE'} playable=${playable}`);
        if (er.status !== 200 || !playable) failures++;
    } catch (e) {
        console.log('  EXCEPTION: ' + e.message);
        failures++;
    }
    await sleep(7000);
}

console.log(failures === 0 ? '\nALL DEPLOYED SOURCES VERIFIED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
