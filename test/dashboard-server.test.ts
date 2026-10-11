import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { startDashboard } from '../src/dashboard-server.ts';

test('live dashboard binds loopback, authenticates snapshots and rejects foreign origins/hosts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dashboard-server-'));
  const auditPath = path.join(directory, 'audit.jsonl');
  fs.writeFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), event: 'http.request', route: 'mcp' }) + '\n');
  const server = startDashboard({ directory, auditPath, port: 0 }, () => ({ upstream: 'running', sessions: 2, activePosts: 0, pid: 123, generation: 1 }));
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;
    const key = fs.readFileSync(path.join(directory, 'dashboard.key'), 'utf8');
    assert.equal(fs.statSync(path.join(directory, 'dashboard.key')).mode & 0o777, 0o600);
    assert.equal((await fetch(`${base}/snapshot`)).status, 401);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${base}/snapshot`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${key}` } })).status, 403);
    assert.equal((await fetch(`${base}/session`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })).status, 401);
    const session = await fetch(`${base}/session`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${key}` } });
    assert.equal(session.status, 204);
    const cookie = session.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const response = await fetch(`${base}/snapshot`, { headers: { cookie: cookie.split(';')[0] } });
    const snapshot = await response.json();
    assert.equal(snapshot.counts.mcp, 1);
    assert.equal(snapshot.status.sessions, 2);
    assert.equal(snapshot.marker, 'desktop-relay-dashboard');
    assert.ok(!snapshot.html.includes(key));
    assert.match(cookie, /Max-Age=86400/);
    assert.equal(response.headers.get('set-cookie'), null, 'polling must not extend expiry');
    const initial = await (await fetch(`${base}/`)).text();
    assert.match(initial, /Loading usage/);
    assert.ok(!initial.includes('data-metric='));
    assert.ok(!initial.includes(key));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dashboard cookies survive restart, expire on the server, and never persist plaintext tokens', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dashboard-restart-'));
  const config = { directory, auditPath: path.join(directory, 'audit.jsonl'), port: 0 };
  const status = () => ({ upstream: 'running', sessions: 0, activePosts: 0, pid: 123, generation: 1 });
  let server = startDashboard(config, status);
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  const baseUrl = async () => {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  try {
    let base = await baseUrl();
    const key = fs.readFileSync(path.join(directory, 'dashboard.key'), 'utf8');
    const login = await fetch(`${base}/session`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${key}` } });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const token = cookie.slice('relay_dashboard='.length);
    assert.notEqual(token, key);
    const stored = fs.readFileSync(path.join(directory, 'dashboard-sessions.json'), 'utf8');
    assert.ok(!stored.includes(token) && !stored.includes(key));
    assert.equal(fs.statSync(path.join(directory, 'dashboard-sessions.json')).mode & 0o777, 0o600);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie } })).status, 200);
    await close();
    server = startDashboard(config, status);
    base = await baseUrl();
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie: 'relay_dashboard=invalid' } })).status, 401);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie: `relay_dashboard=${'0'.repeat(64)}` } })).status, 401);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie: `relay_dashboard=${key}` } })).status, 401);

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(24 * 60 * 60 * 1000 + 1);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${base}/session`, { method: 'POST', headers: { origin: base, cookie } })).status, 401);
    await close();
    server = startDashboard(config, status);
    base = await baseUrl();
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie } })).status, 401);
    const again = await fetch(`${base}/session`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${key}` } });
    assert.equal(again.status, 204, 'local launch key can sign in after expiry');
    assert.equal((await fetch(`${base}/snapshot`, { headers: { cookie: again.headers.get('set-cookie')!.split(';')[0] } })).status, 200);
  } finally {
    await close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('existing dashboard key-cookies migrate once and cannot regain validity after expiry or restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dashboard-migration-'));
  const key = 'a'.repeat(64);
  fs.writeFileSync(path.join(directory, 'dashboard.key'), key, { mode: 0o600 });
  const config = { directory, auditPath: path.join(directory, 'audit.jsonl'), port: 0 };
  const status = () => ({ upstream: 'running', sessions: 0, activePosts: 0, pid: 123, generation: 1 });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    for (const expected of [200, 200, 401, 401]) {
      const server = startDashboard(config, status);
      try {
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const response = await fetch(`http://127.0.0.1:${address.port}/snapshot`, { headers: { cookie: `relay_dashboard=${key}` } });
        assert.equal(response.status, expected);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      t.mock.timers.tick(12 * 60 * 60 * 1000);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
