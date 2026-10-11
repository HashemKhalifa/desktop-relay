import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('watchdog allows startup and unauthenticated listener checks but recovers a dead or stuck daemon', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-watchdog-'));
  const bin = path.join(directory, 'bin');
  const configDir = path.join(directory, '.config/desktop-relay');
  fs.mkdirSync(bin);
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(directory, 'Library/Logs/desktop-relay'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ edge: { kind: 'none' } }));
  // Redirect only the filesystem root in a temporary copy; exercise the real
  // script with deterministic curl/launchctl/ps processes, never live launchd.
  const script = path.join(directory, 'watchdog.sh');
  fs.writeFileSync(script, fs.readFileSync('scripts/watchdog.sh', 'utf8').replaceAll('${HOME}', directory));
  const commands = {
    curl: 'printf "%s" "$PROBE_STATUS"',
    launchctl: 'if [ "$1" = print ]; then [ -n "$PROBE_PID" ] && printf "pid = %s\\n" "$PROBE_PID"; else printf "%s\\n" "$*" >> "$PROBE_ACTIONS"; fi',
    ps: 'printf "%s\\n" "$PROBE_AGE"',
  };
  for (const [name, body] of Object.entries(commands)) fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  const actions = path.join(directory, 'actions');
  try {
    for (const scenario of [
      { code: '200', token: 'fixture', pid: '123', age: '00:10', restart: false },
      { code: '404', token: '', pid: '123', age: '01:00', restart: false },
      { code: '000', token: '', pid: '123', age: '00:14', restart: false },
      { code: '000', token: '', pid: '123', age: '00:29', restart: false },
      { code: '000', token: '', pid: '123', age: '00:30', restart: true },
      { code: '000', token: '', pid: '123', age: '01:02:03', restart: true },
      { code: '000', token: '', pid: '123', age: '1-00:00:01', restart: true },
      { code: '000', token: '', pid: '', age: '', restart: true },
      { code: '404', token: 'fixture', pid: '123', age: '01:00', restart: true },
    ]) {
      fs.writeFileSync(actions, '');
      const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, DR_HEALTH_TOKEN: scenario.token,
        PROBE_STATUS: scenario.code, PROBE_PID: scenario.pid, PROBE_AGE: scenario.age, PROBE_ACTIONS: actions,
      } });
      assert.equal(result.status, 0, result.stderr);
      const calls = fs.readFileSync(actions, 'utf8');
      assert.equal(calls.includes('kickstart -k'), scenario.restart, JSON.stringify(scenario));
      assert.ok(!calls.includes('app.desktop-relay.tunnel'));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
