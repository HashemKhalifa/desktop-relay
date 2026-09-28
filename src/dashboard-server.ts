import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { collect, render } from './dashboard.ts';

type RuntimeStatus = { upstream: string; sessions: number; activePosts: number; pid: number; generation: number };

export function startDashboard(config: { directory: string; auditPath: string; port: number }, status: () => RuntimeStatus): http.Server {
  const keyPath = path.join(config.directory, 'dashboard.key');
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(keyPath, 0o600);
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid local dashboard key');
  const sessionCookie = `relay_dashboard=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
  const script = fs.readFileSync(new URL('./dashboard-live.js', import.meta.url), 'utf8');
  let cached: { until: number; value: Promise<Awaited<ReturnType<typeof collect>>> } | undefined;
  const server = http.createServer((req, res) => {
    void (async () => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
      const address = server.address();
      const host = `127.0.0.1:${typeof address === 'object' && address ? address.port : config.port}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403).end(); return; }
      const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? req.headers.cookie?.split('; ').find(c => c.startsWith('relay_dashboard='))?.slice('relay_dashboard='.length) ?? '';
      const suppliedBytes = Buffer.from(supplied);
      const authenticated = suppliedBytes.length === key.length && crypto.timingSafeEqual(suppliedBytes, Buffer.from(key));
      if (req.method === 'POST' && req.url === '/session') {
        if (!authenticated || req.headers.origin !== `http://${host}`) { res.writeHead(401).end(); return; }
        req.resume();
        res.setHeader('set-cookie', sessionCookie);
        res.writeHead(204).end(); return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (req.url === '/live.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(script); return; }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(render(null, new Date(), true)); return;
      }
      if (req.url !== '/snapshot') { res.writeHead(404).end(); return; }
      if (!authenticated) { res.writeHead(401).end(); return; }
      if (!cached || cached.until <= Date.now()) cached = { until: Date.now() + 5000, value: collect(config.auditPath) };
      const data = await cached.value;
      res.setHeader('set-cookie', sessionCookie);
      const now = new Date();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ marker: 'desktop-relay-dashboard', generatedAt: now.toISOString(), status: status(), counts: data.total, html: render(data, now, true) }));
    })().catch(() => { cached = undefined; if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.requestTimeout = 10000;
  server.listen(config.port, '127.0.0.1');
  return server;
}
