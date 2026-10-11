import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { emptyStore, mint, saveAtomic } from '../src/creds.ts';

test('daemon listens before upstream readiness, preserves auth, then serves MCP', { timeout: 45000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-startup-'));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const store = emptyStore();
  const { secret } = mint(store, { name: 'startup-test', kind: 'bearer', tools: 'all', ratePerMinute: 10000 });
  saveAtomic(path.join(directory, 'principals.json'), store);
  const ready = path.join(directory, 'ready');
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    configDir: directory, listenPort: port, dashboardPort: 0,
    upstreamCmd: [process.execPath, path.resolve('test/fixtures/delayed-upstream.ts'), ready],
    upstreamCwd: process.cwd(),
  }));
  const startedAt = performance.now();
  const child = spawn(process.execPath, ['src/daemon.ts'], {
    env: { ...process.env, DESKTOP_RELAY_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  try {
    let health: { status: number | undefined; upstream: string } | undefined;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try {
        health = await new Promise((resolve, reject) => {
          http.get(`${base}/healthz`, { headers }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, upstream: JSON.parse(body).upstream }));
          }).on('error', reject);
        });
        break;
      } catch { await setTimeout(20); }
    }
    assert.ok(health, `listener did not open while upstream was blocked: ${output}`);
    t.diagnostic(`authenticated health responded after ${Math.round(performance.now() - startedAt)}ms with upstream blocked`);
    assert.equal(health.status, 200);
    assert.ok(['down', 'starting'].includes(health.upstream));
    assert.equal(fs.existsSync(ready), false);
    for (const method of ['POST', 'GET', 'DELETE']) {
      const response = await fetch(`${base}/mcp`, { method, headers });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '1');
      const body = await response.json();
      assert.equal(body.error, 'upstream_not_ready');
      assert.ok(['down', 'starting'].includes(body.upstream));
    }
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 404);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer invalid' } })).status, 404);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      http.get(`${base}/mcp`, { headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(badHost, 403);

    fs.writeFileSync(ready, 'ready');
    let running = false;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/healthz`, { headers });
      if ((await response.json()).upstream === 'running') { running = true; break; }
      await setTimeout(20);
    }
    assert.ok(running, output);
    const initialized = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } },
    }) });
    assert.equal(initialized.status, 200);
    assert.match(await initialized.text(), /serverInfo/);
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const listed = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(listed.status, 200);
    assert.match(await listed.text(), /fixture_ready/);
    assert.equal((await fetch(`${base}/mcp`, { headers })).status, 405);
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      process.kill(-child.pid, 'SIGTERM');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
