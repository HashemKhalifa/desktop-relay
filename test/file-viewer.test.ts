import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Script } from 'node:vm';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Upstream } from '../src/upstream.ts';
import { createSession, closeSession, type SessionCtx } from '../src/session.ts';
import { ResultStore } from '../src/results.ts';

test('file viewer reads exact bounded ranges through the shared upstream with component-only content', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-viewer-'));
  const fixture = path.join(directory, 'example.txt');
  const lines = Array.from({ length: 420 }, (_, i) => `line ${i + 1} — 😀 é <script>not executable</script>`);
  fs.writeFileSync(fixture, lines.join('\n'));
  const upstream = new Upstream(process.execPath, [path.resolve('node_modules/@wonderwhy-er/desktop-commander/dist/index.js')], directory, 'test');
  const principal = { id: 'viewer', name: 'viewer', enabled: true, tools: ['read_file'], allowSharedHistory: false, ratePerMinute: 3000 };
  const restricted = { ...principal, id: 'restricted', tools: ['list_processes'] };
  const credentials = [principal, restricted].map(p => ({ id: p.id, principalId: p.id, kind: 'bearer' as const, secretSha256: '', createdAt: new Date().toISOString() }));
  const events: Record<string, unknown>[] = [];
  const ctx: SessionCtx = { upstream, storeRef: { current: { version: 1, principals: [principal, restricted], credentials } }, sessions: new Map(), version: 'test', rpcDeadlineMs: 15000, maxSessions: 10, results: new ResultStore(), audit(event, fields) { events.push({ event, ...fields }); } };
  const server = http.createServer(async (req, res) => {
    const id = req.headers['mcp-session-id'];
    const index = req.headers.authorization === 'restricted' ? 1 : 0;
    const session = typeof id === 'string' ? ctx.sessions.get(id) : createSession(ctx, index ? restricted : principal, credentials[index]);
    if (!session) { res.writeHead(503).end(); return; }
    await session.transport.handleRequest(req, res);
  });
  const clients: Client[] = [];
  try {
    await upstream.start();
    assert.equal(upstream.state, 'running');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    async function connect(authorization: string) {
      const client = new Client({ name: 'viewer-test', version: '1' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization } } }));
      return client;
    }
    const client = await connect('viewer');
    const inventory = await client.listTools();
    const preview = inventory.tools.find(t => t.name === 'browse_relay_file');
    assert.ok(preview, 'read_file grants must advertise the app-only preview tool');
    assert.deepEqual(preview._meta?.ui, { visibility: ['app'] });
    const resourceUri = 'ui://desktop-relay/file-viewer-v1.html';
    assert.equal((inventory.tools.find(t => t.name === 'read_file')?._meta?.ui as { resourceUri: string }).resourceUri, resourceUri);
    const resource = await client.readResource({ uri: resourceUri });
    assert.ok('text' in resource.contents[0] && resource.contents[0].text.includes('Desktop Relay'));
    assert.doesNotThrow(() => new Script((resource.contents[0] as { text: string }).text.match(/<script>([\s\S]*?)<\/script>/)![1]));
    assert.ok(client.getServerVersion()?.icons?.length);

    const read = (offset: number, length = 200) => client.callTool({ name: 'browse_relay_file', arguments: { path: fixture, offset, length } });
    const first = await read(0);
    const view = first._meta?.fileView as { text: string; firstLine: number; nextOffset: number; totalLines: number; hash: string };
    assert.equal(view.text, lines.slice(0, 200).join('\n'));
    assert.equal(view.firstLine, 1);
    assert.equal(view.nextOffset, 200);
    assert.equal(view.totalLines, 420);
    assert.ok(JSON.stringify(first.content).length < 200);
    assert.ok(!JSON.stringify(first.content).includes(lines[0]));
    assert.equal(first.structuredContent, undefined);
    t.diagnostic(`First range: ${Buffer.byteLength(view.text)} file bytes in component metadata; ${Buffer.byteLength(JSON.stringify(first.content))} bytes in model-facing content.`);
    const last = (await read(400))._meta?.fileView as typeof view;
    assert.equal(last.text, lines.slice(400).join('\n'));
    assert.equal(last.nextOffset, null);
    const tail = (await read(-2, 2))._meta?.fileView as typeof view;
    assert.equal(tail.firstLine, 419);
    assert.equal(tail.text, lines.slice(-2).join('\n'));
    fs.writeFileSync(fixture, ['updated', ...lines.slice(1)].join('\n'));
    assert.notEqual(((await read(0))._meta?.fileView as typeof view).hash, view.hash);
    await assert.rejects(read(0, 201), /length/);
    await assert.rejects(read(0.5), /offset/);
    const missing = await client.callTool({ name: 'browse_relay_file', arguments: { path: path.join(directory, 'missing.txt') } });
    assert.equal(missing.isError, true);
    assert.equal(missing._meta, undefined);
    const denied = await connect('restricted');
    assert.ok(!(await denied.listTools()).tools.some(t => t.name === 'browse_relay_file'));
    await assert.rejects(denied.callTool({ name: 'browse_relay_file', arguments: { path: fixture } }), /not available/);
    await assert.rejects(denied.readResource({ uri: resourceUri }), /not available/);
    assert.ok(events.some(e => e.event === 'tool.result' && e.audience === 'app' && Number(e.metaBytes) > 0));
    assert.ok(!JSON.stringify(events).includes(fixture));
    assert.ok(!JSON.stringify(events).includes(lines[0]));
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    for (const session of ctx.sessions.values()) closeSession(ctx, session);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await upstream.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
