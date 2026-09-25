import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as creds from './creds.ts';
import { createSession, closeSession, type Session, type SessionCtx } from './session.ts';
import { Upstream } from './upstream.ts';
import { unknownGrantNames } from './policy.ts';
import { ResultStore } from './results.ts';
import { startDashboard } from './dashboard-server.ts';

interface Config {
  listenHost: string;
  listenPort: number;
  upstreamCmd: string[];
  upstreamCwd: string;
  publicBaseUrl?: string;
  configDir: string;
  secretsPath: string;
  auditPath: string;
  alertsPath: string;
  controlSockPath: string;
  rpcDeadlineMs: number;
  uploadDeadlineMs: number;
  maxBodyBytes: number;
  maxConcurrentPosts: number;
  maxSessions: number;
  dashboardPort: number;
}

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const CONFIG_PATH = process.env.DESKTOP_RELAY_CONFIG
  ?? path.join(os.homedir(), '.config', 'desktop-relay', 'config.json');

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadConfig(): Config {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const dir = expandHome(raw.configDir ?? '~/.config/desktop-relay');
  const cfg: Config = {
    listenHost: raw.listenHost ?? '127.0.0.1',
    listenPort: raw.listenPort ?? 8788,
    upstreamCmd: raw.upstreamCmd,
    upstreamCwd: expandHome(raw.upstreamCwd ?? os.homedir()),
    publicBaseUrl: raw.publicBaseUrl,
    configDir: dir,
    secretsPath: expandHome(raw.secretsPath ?? `${dir}/principals.json`),
    auditPath: expandHome(raw.auditPath ?? `${dir}/audit.jsonl`),
    alertsPath: expandHome(raw.alertsPath ?? `${dir}/alerts.jsonl`),
    controlSockPath: expandHome(raw.controlSockPath ?? `${dir}/control.sock`),
    rpcDeadlineMs: raw.rpcDeadlineMs ?? 15 * 60 * 1000,
    uploadDeadlineMs: raw.uploadDeadlineMs ?? 10_000,
    maxBodyBytes: raw.maxBodyBytes ?? 16 * 1024 * 1024,
    maxConcurrentPosts: raw.maxConcurrentPosts ?? 32,
    maxSessions: raw.maxSessions ?? 64,
    dashboardPort: raw.dashboardPort ?? 8789,
  };
  if (!Array.isArray(cfg.upstreamCmd) || cfg.upstreamCmd.length === 0 || !path.isAbsolute(cfg.upstreamCmd[0])) {
    throw new Error('config.upstreamCmd must be a non-empty array whose first element is an absolute path');
  }
  return cfg;
}

const cfg = loadConfig();

let store: creds.Store;
try {
  store = creds.load(cfg.secretsPath);
} catch (e) {
  console.error(`credential store: ${(e as Error).message}`);
  process.exit(2);
}
const storeRef = { current: store };

const upstream = new Upstream(cfg.upstreamCmd[0], cfg.upstreamCmd.slice(1), cfg.upstreamCwd, PKG.version);
const sessions = new Map<string, Session>();
const buckets = new Map<string, { tokens: number; ts: number }>();
let activePosts = 0;
let authFailWindow: number[] = [];

function audit(event: string, fields: Record<string, unknown>) {
  try {
    const stat = fs.existsSync(cfg.auditPath) ? fs.statSync(cfg.auditPath) : null;
    if (stat && stat.size > 50 * 1024 * 1024) fs.renameSync(cfg.auditPath, cfg.auditPath + '.1');
    fs.appendFileSync(cfg.auditPath, JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
  } catch (e) {
    console.error('audit write failed:', (e as Error).message);
  }
}

function alert(kind: string, detail: string) {
  audit('alert', { kind, detail });
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `display notification "${detail.replaceAll('"', '\\"')}" with title "desktop-relay"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

function authFailed() {
  const now = Date.now();
  authFailWindow = authFailWindow.filter((t) => now - t < 60_000);
  authFailWindow.push(now);
  if (authFailWindow.length === 20) alert('auth-fail-burst', '20 auth failures in 60s');
}

const ctx: SessionCtx = {
  upstream,
  storeRef,
  sessions,
  version: PKG.version,
  rpcDeadlineMs: cfg.rpcDeadlineMs,
  maxSessions: cfg.maxSessions,
  results: new ResultStore(),
  audit,
};

const allowedHosts = new Set<string>([
  `${cfg.listenHost}:${cfg.listenPort}`,
  `localhost:${cfg.listenPort}`,
  `[::1]:${cfg.listenPort}`,
]);
if (cfg.publicBaseUrl) {
  try { allowedHosts.add(new URL(cfg.publicBaseUrl).host); } catch { /* validated below */ }
}

function send(res: http.ServerResponse, status: number, body?: object) {
  res.writeHead(status, body === undefined ? undefined : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, maxBytes: number, deadlineMs: number): Promise<Buffer | 'too-large' | 'too-slow'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => { req.destroy(); resolve('too-slow'); }, deadlineMs);
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { clearTimeout(timer); req.destroy(); resolve('too-large'); return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.on('error', () => { clearTimeout(timer); resolve('too-slow'); });
  });
}

function bucketAllow(principalId: string, perMinute: number): boolean {
  const now = Date.now();
  let b = buckets.get(principalId);
  if (!b) { b = { tokens: 30, ts: now }; buckets.set(principalId, b); }
  b.tokens = Math.min(30, b.tokens + ((now - b.ts) / 60_000) * perMinute);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function findInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && typeof m === 'object' && (m as { method?: string }).method === 'initialize');
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !allowedHosts.has(host)) { send(res, 403); return; }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (!allowedHosts.has(new URL(origin).host)) { send(res, 403); return; }
    } catch { send(res, 403); return; }
  } else if (origin !== undefined) { send(res, 403); return; }

  const url = new URL(req.url ?? '/', `http://${host}`);
  const seg = url.pathname.split('/').filter(Boolean);
  const last = seg[seg.length - 1];
  if (last !== 'mcp' && last !== 'healthz') { send(res, 404); return; }
  const route = last === 'healthz' ? 'healthz' : 'mcp';
  const pathToken = seg.length === 2 ? seg[0] : undefined;
  if (seg.length > 2) { send(res, 404); return; }

  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === 'string' ? /^Bearer (\S+)$/.exec(authHeader)?.[1] : undefined;
  const auth = pathToken !== undefined
    ? creds.authenticate(storeRef.current, { pathToken })
    : bearer !== undefined
      ? creds.authenticate(storeRef.current, { bearer })
      : null;
  if (auth === null) { authFailed(); send(res, 404); return; }
  const { principal, credential } = auth;

  res.once('finish', () => audit('http.request', {
    principalId: principal.id,
    route,
    method: req.method,
    status: res.statusCode,
  }));

  if (!bucketAllow(principal.id, principal.ratePerMinute)) { send(res, 429); return; }

  if (route === 'healthz') {
    send(res, 200, {
      ok: true,
      marker: 'desktop-relay-health',
      upstream: upstream.state,
      generation: upstream.generation,
      sessions: sessions.size,
      pid: process.pid,
    });
    return;
  }

  if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); res.end(); return; }

  const sidHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sidHeader === 'string' ? sidHeader : undefined;

  if (req.method === 'DELETE') {
    const sess = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (!sess) { send(res, 404); return; }
    await sess.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') { send(res, 404); return; }

  if (activePosts >= cfg.maxConcurrentPosts) { send(res, 503); return; }
  activePosts++;
  try {
    const body = await readBody(req, cfg.maxBodyBytes, cfg.uploadDeadlineMs);
    if (body === 'too-large') { send(res, 413); return; }
    if (body === 'too-slow') { send(res, 408); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); }
    catch {
      send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }

    if (sessionId !== undefined) {
      const sess = sessions.get(sessionId);
      if (!sess
        || sess.generation !== upstream.generation
        || !creds.credentialValid(storeRef.current, sess.credentialId)) {
        if (sess) closeSession(ctx, sess);
        send(res, 404);
        return;
      }
      sess.activeRequests++;
      sess.lastActivity = Date.now();
      try {
        await sess.transport.handleRequest(req, res, parsed);
      } finally {
        sess.activeRequests--;
        sess.lastActivity = Date.now();
      }
      return;
    }

    if (!findInitialize(parsed)) { send(res, 400); return; }
    const sess = createSession(ctx, principal, credential);
    if (sess === null) { send(res, 503); return; }
    sess.activeRequests++;
    sess.lastActivity = Date.now();
    try {
      await sess.transport.handleRequest(req, res, parsed);
    } finally {
      sess.activeRequests--;
      sess.lastActivity = Date.now();
    }
  } finally {
    activePosts--;
  }
}

// --- control socket: daemon is the only writer of principals.json ---

function applyControl(op: Record<string, unknown>): object {
  const next: creds.Store = JSON.parse(JSON.stringify(storeRef.current));
  const saveAndSwap = () => {
    creds.saveAtomic(cfg.secretsPath, next);
    storeRef.current = next;
  };
  switch (op.op) {
    case 'mint': {
      const out = creds.mint(next, {
        name: String(op.name),
        kind: op.kind === 'path-only' ? 'path-only' : 'bearer',
        tools: op.tools === 'all' ? 'all' : (op.tools as string[]),
        allowSharedHistory: op.allowSharedHistory === true,
        ratePerMinute: typeof op.ratePerMinute === 'number' ? op.ratePerMinute : undefined,
      });
      saveAndSwap();
      return { ok: true, principalId: out.principal.id, credentialId: out.credential.id, secret: out.secret };
    }
    case 'rotate': {
      const out = creds.rotate(next, String(op.principalId), Number(op.graceMs ?? 24 * 3600 * 1000));
      if (!out) return { ok: false, error: 'unknown or disabled principal' };
      saveAndSwap();
      return { ok: true, credentialId: out.credential.id, secret: out.secret };
    }
    case 'revoke': {
      if (!creds.revoke(next, String(op.principalId))) return { ok: false, error: 'unknown principal' };
      saveAndSwap();
      for (const sess of [...sessions.values()]) {
        if (sess.principalId === op.principalId) closeSession(ctx, sess);
      }
      ctx.results.revoke(String(op.principalId));
      audit('principal.revoked', { principalId: op.principalId });
      return { ok: true };
    }
    case 'list':
      return { ok: true, principals: creds.describe(storeRef.current) };
    case 'status':
      return {
        ok: true,
        upstream: upstream.state,
        generation: upstream.generation,
        sessions: sessions.size,
        activePosts,
        pid: process.pid,
      };
    default:
      return { ok: false, error: 'unknown op' };
  }
}

function startControlSocket() {
  fs.mkdirSync(path.dirname(cfg.controlSockPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(cfg.controlSockPath); } catch {}
  const srv = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      conn.pause();
      try {
        const op = JSON.parse(line);
        const reply = applyControl(op);
        conn.end(JSON.stringify(reply) + '\n');
      } catch (e) {
        conn.end(JSON.stringify({ ok: false, error: (e as Error).message }) + '\n');
      }
    });
  });
  srv.listen(cfg.controlSockPath);
  fs.chmodSync(cfg.controlSockPath, 0o600);
  return srv;
}

// --- lifecycle ---

upstream.onstatechange = (state, generation) => {
  audit('upstream.state', { state, generation });
  // Sessions are bound to the child's protocol identity: when it dies every live
  // session is invalid regardless of which generation number is next.
  if (state === 'down' || state === 'dead') {
    for (const sess of [...sessions.values()]) closeSession(ctx, sess);
  }
  if (state === 'running') {
    const inventory = upstream.toolInventory().map((t) => t.name);
    for (const p of storeRef.current.principals) {
      const unknown = unknownGrantNames(p.tools, inventory);
      if (unknown.length) alert('unknown-tool-grant', `principal ${p.name} grants unknown tools: ${unknown.join(',')}`);
    }
  }
};

// Reclaim abandoned sessions without interrupting in-flight requests.
setInterval(() => {
  for (const sess of [...sessions.values()]) {
    if (!creds.credentialValid(storeRef.current, sess.credentialId)
      || (sess.activeRequests === 0 && Date.now() - sess.lastActivity > 15 * 60_000)) closeSession(ctx, sess);
  }
}, 15_000).unref();

const httpServer = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('handler error:', e);
    try {
      if (!res.headersSent) send(res, 500);
      res.end();
    } catch { /* socket already gone */ }
  });
});
const controlServer = startControlSocket();
const dashboardServer = startDashboard({ directory: path.dirname(CONFIG_PATH), auditPath: cfg.auditPath, port: cfg.dashboardPort }, () => ({
  upstream: upstream.state, sessions: sessions.size, activePosts, pid: process.pid, generation: upstream.generation,
}));
dashboardServer.on('error', (error) => console.error('dashboard listener:', error.message));

upstream.start().then(() => {
  httpServer.listen(cfg.listenPort, cfg.listenHost, () => {
    console.log(`desktop-relay listening on http://${cfg.listenHost}:${cfg.listenPort}`);
  });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const sess of [...sessions.values()]) closeSession(ctx, sess);
  await upstream.stop();
  httpServer.close();
  controlServer.close();
  dashboardServer.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
