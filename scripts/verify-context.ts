import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const base = process.argv[2] ?? 'http://127.0.0.1:8788';
const ctl = path.resolve(import.meta.dirname, '../bin/dc-relayctl');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-context-proof-'));
const principals: string[] = [];
const clients: Client[] = [];
const text = (result: CallToolResult) => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const bytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result));

function mint() {
  const credential = JSON.parse(execFileSync(ctl, ['mint', '--name', 'context-verification', '--kind', 'bearer', '--tools', 'all'], { encoding: 'utf8' }));
  principals.push(credential.principalId);
  return credential;
}

async function connect(secret: string) {
  const client = new Client({ name: 'context-verification', version: '1' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
  return client;
}

async function recover(client: Client, resultId: string) {
  let recovered = '';
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const result = await client.callTool({ name: 'read_relay_result', arguments: { resultId, offset } }) as CallToolResult;
    const chunk = text(result);
    assert.ok(Buffer.byteLength(chunk) <= 12288);
    recovered += chunk;
    offset = result.structuredContent!.nextOffset as number | null;
    pages++;
  }
  return { recovered, pages };
}

try {
  const credential = mint();
  const client = await connect(credential.secret);
  const inventory = await client.listTools();
  assert.ok(inventory.tools.some(t => t.name === 'read_relay_result'));
  assert.ok(!inventory.tools.some(t => t.name === 'set_config_value'));
  const expected = 'context-😀-é\n'.repeat(3000);
  const fixture = path.join(directory, 'fixture.txt');
  fs.writeFileSync(fixture, expected);
  const result = await client.callTool({ name: 'read_file', arguments: { path: fixture, length: 10000 } }) as CallToolResult;
  const resultId = text(result).match(/resultId: ([\w-]+)/)![1];
  assert.ok(bytes(result) < 6000);
  const secondSession = await connect(credential.secret);
  const filePages = await recover(secondSession, resultId);
  const direct = await client.callTool({ name: 'read_file', arguments: { path: fixture, length: 10000, origin: 'ui' } }) as CallToolResult;
  assert.equal(filePages.recovered, text(direct));
  assert.ok(filePages.recovered.includes(expected.trimEnd()));
  const other = await connect(mint().secret);
  await assert.rejects(other.callTool({ name: 'read_relay_result', arguments: { resultId } }), /unavailable/);

  const counter = path.join(directory, 'counter');
  const program = path.join(directory, 'once.py');
  fs.writeFileSync(program, `from pathlib import Path\np = Path(${JSON.stringify(counter)})\np.write_text(str(int(p.read_text()) + 1) if p.exists() else '1')\nprint('command-context-' * 3000)\n`);
  // A tools/call is never retried: it may have executed even if its response fails.
  const commandResult = await client.callTool({ name: 'start_process', arguments: { command: `python3 '${program}'`, timeout_ms: 2000 } }) as CallToolResult;
  const commandId = text(commandResult).match(/resultId: ([\w-]+)/)![1];
  assert.ok(bytes(commandResult) < 6000);
  const commandPages = await recover(secondSession, commandId);
  assert.ok(commandPages.recovered.includes('command-context-'.repeat(3000)));
  assert.equal(fs.readFileSync(counter, 'utf8'), '1');
  execFileSync(ctl, ['revoke', '--principal-id', credential.principalId], { stdio: 'ignore' });
  principals.splice(principals.indexOf(credential.principalId), 1);
  await assert.rejects(secondSession.callTool({ name: 'read_relay_result', arguments: { resultId } }));
  console.log(JSON.stringify({ publicEndpoint: new URL(base).host, inventoryBytes: bytes(inventory), filePreviewBytes: bytes(result), fileRecoveredBytes: Buffer.byteLength(filePages.recovered), filePages: filePages.pages, commandPreviewBytes: bytes(commandResult), commandRecoveredBytes: Buffer.byteLength(commandPages.recovered), commandPages: commandPages.pages, commandExecutions: 1, crossPrincipalIsolation: 'PASS', revoke: 'PASS' }, null, 2));
} finally {
  for (const client of clients) await client.close().catch(() => {});
  for (const principal of principals) execFileSync(ctl, ['revoke', '--principal-id', principal], { stdio: 'ignore' });
  fs.rmSync(directory, { recursive: true, force: true });
}
