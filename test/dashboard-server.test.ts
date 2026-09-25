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
    assert.match(await (await fetch(`${base}/`)).text(), /Connecting/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
