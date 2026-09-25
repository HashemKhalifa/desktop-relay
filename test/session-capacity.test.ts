import assert from 'node:assert/strict';
import test from 'node:test';
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
