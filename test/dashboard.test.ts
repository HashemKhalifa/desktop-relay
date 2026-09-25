import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('dashboard counts requests and tool calls across audit rotation and month boundaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-relay-dashboard-'));
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toISOString();
    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).toISOString();
    const auditPath = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(`${auditPath}.1`, [
      JSON.stringify({ ts: previousMonth, event: 'http.request', route: 'mcp', method: 'POST', status: 200 }),
      JSON.stringify({ ts: previousMonth, event: 'tool.call', tool: 'start_process', principalId: 'private-id' }),
    ].join('\n') + '\n');
    fs.writeFileSync(auditPath, [
      JSON.stringify({ ts: today, event: 'http.request', route: 'mcp', method: 'POST', status: 200 }),
      JSON.stringify({ ts: today, event: 'http.request', route: 'mcp', method: 'POST', status: 400 }),
      JSON.stringify({ ts: today, event: 'http.request', route: 'healthz', method: 'GET', status: 200 }),
      JSON.stringify({ ts: today, event: 'tool.call', tool: 'list_processes', principalId: 'private-id' }),
      JSON.stringify({ ts: today, event: 'tool.result', tool: 'list_processes' }),
      'null',
      'incomplete audit line',
    ].join('\n') + '\n');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ auditPath }));

    const result = spawnSync(process.execPath, ['src/dashboard.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DESKTOP_RELAY_CONFIG: config },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const html = fs.readFileSync(path.join(dir, 'dashboard.html'), 'utf8');
    const metric = (name: string) => Number(html.match(new RegExp(`data-metric="${name}"[^>]*>(\\d+)<`))?.[1]);
    assert.equal(metric('today-mcp'), 2);
    assert.equal(metric('today-health'), 1);
    assert.equal(metric('today-tools'), 1);
    assert.equal(metric('month-mcp'), 2);
    assert.equal(metric('all-mcp'), 3);
    assert.equal(metric('all-tools'), 2);
    assert.ok(!html.includes('private-id'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
