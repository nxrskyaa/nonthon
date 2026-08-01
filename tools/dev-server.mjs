#!/usr/bin/env node
/**
 * Minimal local server that emulates Vercel's routing for this project so the
 * auth gate and API routes can be exercised without deploying.
 *
 *   node tools/dev-server.mjs 8899
 *
 * Reads AUTH_SECRET / ACCESS_HASHES from the environment (or .env.local).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// Load .env.local if present (KEY=VALUE lines)
const envFile = process.env.ENV_FILE || path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}

const routes = {
    '/api/index': './api/index.js',
    '/api/login': './api/login.js',
    '/api/logout': './api/logout.js',
    '/api/stream': './api/stream.js',
    '/api/subs': './api/subs.js',
    '/api/sub': './api/sub.js',
};

function shim(res) {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
        return res;
    };
    res.send = (body) => { res.end(body); return res; };
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    let pathname = u.pathname;

    // Vercel rewrites
    if (pathname === '/' || pathname === '/index.html' || pathname === '/app') pathname = '/api/index';

    shim(res);
    req.query = Object.fromEntries(u.searchParams.entries());

    if (pathname === '/robots.txt') {
        res.setHeader('Content-Type', 'text/plain');
        return res.end(fs.readFileSync('public/robots.txt'));
    }

    const modPath = routes[pathname];
    if (!modPath) {
        res.statusCode = 404;
        return res.end('not found');
    }

    if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        try { req.body = JSON.parse(raw); } catch { req.body = {}; }
    }

    try {
        const abs = path.join(root, modPath);
        const mod = await import(pathToFileURL(abs).href + '?t=' + Date.now());
        await mod.default(req, res);
    } catch (e) {
        console.error('handler error', e);
        if (!res.headersSent) { res.statusCode = 500; res.end('error: ' + e.message); }
    }
});

const port = Number(process.argv[2] || 8899);
server.listen(port, () => console.log('dev server on http://localhost:' + port));
