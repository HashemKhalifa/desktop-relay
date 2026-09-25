import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createSession, closeSession, type SessionCtx } from '../src/session.ts';
import { Upstream } from '../src/upstream.ts';
import { ResultStore } from '../src/results.ts';
import type { Principal, Credential } from '../src/creds.ts';

test('capacity reclaims oldest idle session but preserves recent and in-flight sessions', () => {
  const upstream = new Upstream(process.execPath, [], process.cwd(), 'test');
  upstream.state = 'running';
  const principal: Principal = { id: 'test', name: 'test', enabled: true, tools: 'all', allowSharedHistory: false, ratePerMinute: 60 };
  const credential: Credential = { id: 'credential', principalId: principal.id, kind: 'bearer', secretSha256: '', createdAt: new Date().toISOString() };
  const ctx: SessionCtx = { upstream, storeRef: { current: { version: 1, principals: [principal], credentials: [credential] } }, sessions: new Map(), version: 'test', rpcDeadlineMs: 1000, maxSessions: 2, results: new ResultStore(), audit() {} };
  const first = createSession(ctx, principal, credential)!;
  const second = createSession(ctx, principal, credential)!;
  first.id = 'first'; second.id = 'second';
  ctx.sessions.set(first.id, first); ctx.sessions.set(second.id, second);
  try {
    assert.equal(createSession(ctx, principal, credential), null);
    first.lastActivity = Date.now() - 120_000;
    first.activeRequests = 1;
    assert.equal(createSession(ctx, principal, credential), null);
    second.lastActivity = Date.now() - 61_000;
    const replacement = createSession(ctx, principal, credential);
    assert.ok(replacement);
    assert.equal(ctx.sessions.has('first'), true);
    assert.equal(ctx.sessions.has('second'), false);
    closeSession(ctx, replacement);
  } finally {
    closeSession(ctx, first); closeSession(ctx, second);
  }
});


test('300 real HTTP initializations stay bounded and recover after idle eviction', async () => {
  const upstream = new Upstream(process.execPath, [], process.cwd(), 'test');
  upstream.state = 'running';
  const principal: Principal = { id: 'test', name: 'test', enabled: true, tools: 'all', allowSharedHistory: false, ratePerMinute: 60 };
  const credential: Credential = { id: 'credential', principalId: principal.id, kind: 'bearer', secretSha256: '', createdAt: new Date().toISOString() };
  const ctx: SessionCtx = { upstream, storeRef: { current: { version: 1, principals: [principal], credentials: [credential] } }, sessions: new Map(), version: 'test', rpcDeadlineMs: 1000, maxSessions: 300, results: new ResultStore(), audit() {} };
  const server = http.createServer(async (req, res) => {
    const session = createSession(ctx, principal, credential);
    if (!session) { res.writeHead(503).end(); return; }
    await session.transport.handleRequest(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const initialize = async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'capacity-test', version: '1' } } }),
    });
    await response.text();
    return response.status;
  };
  try {
    for (let i = 0; i < 300; i++) assert.equal(await initialize(), 200);
    assert.equal(ctx.sessions.size, 300);
    assert.equal(await initialize(), 503);
    const oldest = ctx.sessions.values().next().value!;
    oldest.lastActivity = Date.now() - 61_000;
    assert.equal(await initialize(), 200);
    assert.equal(ctx.sessions.size, 300);
    assert.equal(ctx.sessions.has(oldest.id!), false);
  } finally {
    for (const session of ctx.sessions.values()) closeSession(ctx, session);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
