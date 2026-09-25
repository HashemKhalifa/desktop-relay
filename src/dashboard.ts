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
  const peak = Math.max(1, ...keys.map((key) => data.get(key)?.mcp ?? 0));
  return keys.map((key) => {
    const count = data.get(key) ?? empty();
    const width = Math.round(count.mcp / peak * 100);
    return `<tr><th scope="row">${key}</th><td><div class="bar" style="width:${width}%"></div><span>${count.mcp}</span></td><td>${count.tools}</td><td>${count.health}</td></tr>`;
  }).join('\n');
}

function card(label: string, name: string, value: number): string {
  return `<div class="card"><span>${label}</span><strong data-metric="${name}">${value}</strong></div>`;
}

function render(data: Awaited<ReturnType<typeof collect>>, now: Date): string {
  const today = data.days.get(dayKey(now)) ?? empty();
  const month = data.months.get(monthKey(now)) ?? empty();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Desktop Relay usage</title>
<style>
  :root{font:16px system-ui,sans-serif;color-scheme:light dark}body{max-width:1050px;margin:0 auto;padding:32px 20px;line-height:1.4}
  h1{margin-bottom:0}p{color:GrayText}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin:28px 0}
  .card{border:1px solid GrayText;border-radius:12px;padding:16px}.card span{display:block;font-size:.82rem;color:GrayText}.card strong{font-size:2rem}
  .tables{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th,td{text-align:right;padding:7px 5px;border-bottom:1px solid GrayText}th:first-child{text-align:left}td:nth-child(2){min-width:85px}
  .bar{height:6px;background:#3b82f6;border-radius:4px;float:left;margin-top:8px;margin-right:6px}small{color:GrayText}
</style></head><body>
<h1>Desktop Relay usage</h1><p>Generated ${now.toLocaleString()} (${zone}) from the local audit log.</p>
<div class="cards">
${card('MCP requests today', 'today-mcp', today.mcp)}
${card('Tool calls today', 'today-tools', today.tools)}
${card('Health checks today', 'today-health', today.health)}
${card('MCP requests this month', 'month-mcp', month.mcp)}
${card('Tool calls this month', 'month-tools', month.tools)}
${card('MCP requests retained', 'all-mcp', data.total.mcp)}
${card('Tool calls retained', 'all-tools', data.total.tools)}
</div>
<div class="tables"><section><h2>Last 14 days</h2><table><thead><tr><th>Day</th><th>MCP requests</th><th>Tool calls</th><th>Health</th></tr></thead><tbody>
${rows(periodKeys(now, 14, 'day'), data.days)}
</tbody></table></section><section><h2>Last 12 months</h2><table><thead><tr><th>Month</th><th>MCP requests</th><th>Tool calls</th><th>Health</th></tr></thead><tbody>
${rows(periodKeys(now, 12, 'month'), data.months)}
</tbody></table></section></div>
<p><small>Requests are completed authenticated MCP HTTP requests. Health checks are separate. Tool calls count dispatches, including calls whose outcome may be unknown. Request counts begin when request auditing was added; earlier requests cannot be reconstructed. Totals cover only the current and previous retained audit files. This relay does not see ChatGPT tokens or model costs. Run <code>dc-relayctl dashboard</code> again to refresh.</small></p>
</body></html>`;
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
