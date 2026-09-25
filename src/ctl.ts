import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Control client: sends one JSON op to the daemon's unix socket, prints the reply.
// The daemon is the only writer of principals.json; mint/rotate secrets appear
// exactly once, in this process's stdout.

const sockPath = process.env.DESKTOP_RELAY_CONTROL
  ?? path.join(os.homedir(), '.config', 'desktop-relay', 'control.sock');

function parseArgs(argv: string[]): Record<string, unknown> {
  const op: Record<string, unknown> = { op: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--name': op.name = next(); break;
      case '--kind': op.kind = next(); break;
      case '--tools': {
        const v = next();
        op.tools = v === 'all' ? 'all' : v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--rate': op.ratePerMinute = Number(next()); break;
      case '--allow-shared-history': op.allowSharedHistory = true; break;
      case '--principal-id': op.principalId = next(); break;
      case '--grace-hours': op.graceMs = Number(next()) * 3600 * 1000; break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return op;
}

const USAGE = `usage: ctl <op> [flags]
  mint   --name N --kind bearer|path-only --tools all|a,b,c [--rate N] [--allow-shared-history]
  rotate --principal-id P [--grace-hours N]
  revoke --principal-id P
  list
  status`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { console.error(USAGE); process.exit(2); }
  let op: Record<string, unknown>;
  try {
    op = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message + '\n' + USAGE);
    process.exit(2);
  }
  const reply = await new Promise<string>((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(op) + '\n'));
    conn.on('data', (c) => { buf += c.toString('utf8'); });
    conn.on('end', () => resolve(buf));
    conn.on('error', reject);
  });
  const parsed = JSON.parse(reply);
  console.log(JSON.stringify(parsed, null, 2));
  if (!parsed.ok) process.exit(1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
