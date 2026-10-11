import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256hex } from './creds.ts';

const SESSION_MS = 24 * 60 * 60 * 1000;
type StoredSession = { hash: string; expiresAt: number };

export class DashboardSessions {
  private file: string;
  private sessions: StoredSession[];

  constructor(directory: string, legacyKey?: string) {
    this.file = path.join(directory, 'dashboard-sessions.json');
    if (fs.existsSync(this.file)) {
      if ((fs.statSync(this.file).mode & 0o777) !== 0o600) throw new Error('dashboard sessions require 0600 permissions');
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(raw) || !raw.every((row): row is StoredSession =>
        row !== null && typeof row === 'object'
        && typeof row.hash === 'string' && /^[a-f0-9]{64}$/.test(row.hash)
        && Number.isSafeInteger(row.expiresAt) && row.expiresAt > 0)) {
        throw new Error('invalid dashboard sessions');
      }
      this.sessions = raw;
    } else {
      // Import the old key-cookie once. Restarts never extend this deadline.
      this.sessions = legacyKey ? [{ hash: sha256hex(legacyKey), expiresAt: Date.now() + SESSION_MS }] : [];
      this.save();
    }
  }

  expiresAt(token: string): number | undefined {
    if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
    const hash = sha256hex(token);
    return this.sessions.find(session => session.expiresAt > Date.now()
      && crypto.timingSafeEqual(Buffer.from(session.hash), Buffer.from(hash)))?.expiresAt;
  }

  create(): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_MS;
    this.sessions = this.sessions.filter(session => session.expiresAt > Date.now());
    this.sessions.push({ hash: sha256hex(token), expiresAt });
    this.save();
    return { token, expiresAt };
  }

  private save(): void {
    const temporary = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.sessions) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
