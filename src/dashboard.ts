import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type Counts = { mcp: number; health: number; tools: number };
const empty = (): Counts => ({ mcp: 0, health: 0, tools: 0 });

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthKey(date: Date): string {
  return dayKey(new Date(date.getFullYear(), date.getMonth(), 1)).slice(0, 7);
}

function record(counts: Counts, event: string, route: unknown): void {
  if (event === 'http.request' && route === 'mcp') counts.mcp++;
  if (event === 'http.request' && route === 'healthz') counts.health++;
  if (event === 'tool.call') counts.tools++;
}

async function collect(auditPath: string): Promise<{ days: Map<string, Counts>; months: Map<string, Counts>; total: Counts }> {
  const days = new Map<string, Counts>();
  const months = new Map<string, Counts>();
  const total = empty();

  for (const file of [`${auditPath}.1`, auditPath]) {
    if (!fs.existsSync(file)) continue;
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      let row: { ts?: unknown; event?: unknown; route?: unknown };
      try { row = JSON.parse(line); } catch { continue; }
      if (row === null || typeof row !== 'object' || typeof row.ts !== 'string' || typeof row.event !== 'string') continue;
      const date = new Date(row.ts);
      if (Number.isNaN(date.getTime())) continue;
      const day = dayKey(date);
      const month = monthKey(date);
      if (!days.has(day)) days.set(day, empty());
      if (!months.has(month)) months.set(month, empty());
      record(days.get(day)!, row.event, row.route);
      record(months.get(month)!, row.event, row.route);
      record(total, row.event, row.route);
    }
  }
  return { days, months, total };
}

function periodKeys(now: Date, count: number, unit: 'day' | 'month'): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = unit === 'day'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - index)
      : new Date(now.getFullYear(), now.getMonth() - index, 1);
    return unit === 'day' ? dayKey(date) : monthKey(date);
  });
}

function rows(keys: string[], data: Map<string, Counts>): string {
  return keys.map((key) => {
    const count = data.get(key) ?? empty();
    return `<tr><th scope="row">${key}</th><td>${count.mcp}</td><td>${count.tools}</td><td>${count.health}</td></tr>`;
  }).join('\n');
}

function activityChart(keys: string[], data: Map<string, Counts>): string {
  const peak = Math.max(1, ...keys.flatMap((key) => {
    const count = data.get(key) ?? empty();
    return [count.mcp, count.tools];
  }));
  const bars = keys.map((key) => {
    const count = data.get(key) ?? empty();
    const label = `${key}: ${count.mcp} MCP requests, ${count.tools} tool calls`;
    return `<div class="chart-day" role="img" aria-label="${label}" title="${label}"><div class="bars"><div class="column" style="height:${count.mcp / peak * 100}%"></div><div class="column tools" style="height:${count.tools / peak * 100}%"></div></div></div>`;
  }).join('');
  return `<div class="chart"><div class="chart-grid">${bars}</div><div class="chart-labels" aria-hidden="true">${keys.map((key) => `<span>${key.slice(5).replace('-', '/')}</span>`).join('')}</div></div>`;
}

function render(data: Awaited<ReturnType<typeof collect>>, now: Date): string {
  const today = data.days.get(dayKey(now)) ?? empty();
  const month = data.months.get(monthKey(now)) ?? empty();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const styles = fs.readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Desktop Relay · Usage</title><style>${styles}</style></head>
<body><div class="relay">
<header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true">Ⅱ</span> Desktop Relay</div><span class="pill">Usage snapshot</span></header>
<main>
<div class="intro"><div><div class="eyebrow">Your Mac · Your infrastructure</div><h1>Usage overview</h1><p>Daily and monthly activity on your Mac.</p></div><div class="timestamp">Generated · ${zone}<time datetime="${now.toISOString()}">${now.toLocaleString()}</time></div></div>
<section class="metrics" aria-label="Usage totals">
<div class="metric"><span class="metric-label">MCP requests today</span><strong data-metric="today-mcp">${today.mcp}</strong><span class="metric-note">Authenticated requests · ${dayKey(now)}</span></div>
<div class="metric"><span class="metric-label">Tool calls today</span><strong data-metric="today-tools">${today.tools}</strong><span class="metric-note">Commands dispatched to Desktop Commander</span></div>
<div class="metric"><span class="metric-label">MCP requests this month</span><strong data-metric="month-mcp">${month.mcp}</strong><span class="metric-note"><span data-metric="month-tools">${month.tools}</span> tool calls · ${monthKey(now)}</span></div>
</section>
<section class="panel" aria-labelledby="activity-title"><div class="panel-header"><div><h2 id="activity-title">Activity over time</h2><p>Last 14 days · counts from retained logs</p></div><div class="legend"><span><i class="dot"></i>MCP requests</span><span><i class="dot tools"></i>Tool calls</span></div></div>
${activityChart(periodKeys(now, 14, 'day').reverse(), data.days)}
</section>
<div class="ledgers"><section class="panel" aria-labelledby="daily-title"><div class="panel-header"><div><h2 id="daily-title">Daily usage</h2><p>Requests, tool calls, and health checks</p></div><span class="eyebrow">14 days</span></div><div class="table-wrap"><table><thead><tr><th scope="col">DAY</th><th scope="col">REQUESTS</th><th scope="col">TOOLS</th><th scope="col">HEALTH</th></tr></thead><tbody>
${rows(periodKeys(now, 14, 'day'), data.days)}
</tbody></table></div></section><section class="panel" aria-labelledby="monthly-title"><div class="panel-header"><div><h2 id="monthly-title">Monthly usage</h2><p>History available in the retained logs</p></div><span class="eyebrow">12 months</span></div><div class="table-wrap"><table><thead><tr><th scope="col">MONTH</th><th scope="col">REQUESTS</th><th scope="col">TOOLS</th><th scope="col">HEALTH</th></tr></thead><tbody>
${rows(periodKeys(now, 12, 'month'), data.months)}
</tbody></table></div></section></div>
<section class="panel"><div class="retained"><span>Retained requests <strong data-metric="all-mcp">${data.total.mcp}</strong></span><span>Retained tool calls <strong data-metric="all-tools">${data.total.tools}</strong></span><span>Health checks today <strong data-metric="today-health">${today.health}</strong></span></div><div class="notes"><details><summary>What these numbers include</summary><p>Requests are completed authenticated MCP HTTP requests, including failed responses. Health checks are separate. Tool calls count dispatches, including calls whose outcome may be unknown. Multiple protocol requests may support one tool call.</p><p>Counts cover the current and previous retained audit files. A zero means no recorded events in those files; it does not establish no activity before logging began or after older logs were removed. Earlier HTTP requests cannot be reconstructed. ChatGPT token usage and model costs are not available to this relay.</p></details><div class="refresh"><span>Refresh and reopen from the relay folder</span><code>bin/dc-relayctl dashboard</code></div></div></section>
</main><footer><span>Private report · stored on this Mac</span><span>Snapshot, updated when you run the command</span></footer>
</div></body></html>`;
}

async function main(): Promise<void> {
  const configPath = process.env.DESKTOP_RELAY_CONFIG ?? path.join(os.homedir(), '.config', 'desktop-relay', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { auditPath: string };
  const output = path.join(path.dirname(configPath), 'dashboard.html');
  const html = render(await collect(config.auditPath), new Date());
  const temp = `${output}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, html, { mode: 0o600 });
    fs.renameSync(temp, output);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  console.log(output);
}

main().catch((error) => { console.error(`dashboard: ${(error as Error).message}`); process.exitCode = 1; });
