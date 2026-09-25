import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Principal/Credential/Session data model:
//   Principal  — stable identity, tool grants, limits, enabled flag.
//   Credential — versioned secret of one principal; rotation = new credential +
//                expiresAt on the old (24h grace, enforced on live sessions).
//                revoke = principal.enabled=false; never mints a replacement.
//   Session    — in-memory only (session.ts), bound to (principalId, credentialId).

export interface Principal {
  id: string;
  name: string;
  enabled: boolean;
  tools: string[] | 'all';
  allowSharedHistory: boolean;
  ratePerMinute: number;
}

export interface Credential {
  id: string;
  principalId: string;
  kind: 'bearer' | 'path-only';
  secretSha256: string;
  createdAt: string;
  expiresAt?: string;
}

export interface Store {
  version: 1;
  principals: Principal[];
  credentials: Credential[];
}

export function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function timingEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export function emptyStore(): Store {
  return { version: 1, principals: [], credentials: [] };
}

// Refuses on unreadable file, bad JSON, bad shape, or loose permissions —
// never silently weakens auth.
export function load(filePath: string): Store {
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${filePath}: permissions must be 0600 (got ${(stat.mode & 0o777).toString(8)})`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Store;
  if (raw.version !== 1 || !Array.isArray(raw.principals) || !Array.isArray(raw.credentials)) {
    throw new Error(`${filePath}: invalid store shape`);
  }
  return raw;
}

export function saveAtomic(filePath: string, store: Store): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function credUsable(cred: Credential, store: Store): Principal | null {
  if (cred.expiresAt !== undefined && Date.parse(cred.expiresAt) <= Date.now()) return null;
  const principal = store.principals.find((p) => p.id === cred.principalId);
  return principal?.enabled ? principal : null;
}

// bearer: Authorization header value already stripped to the token.
// pathToken: the /<token>/mcp path segment; it IS the complete secret for its tier.
export function authenticate(
  store: Store,
  input: { bearer?: string; pathToken?: string },
): { principal: Principal; credential: Credential } | null {
  const hash = input.bearer !== undefined ? sha256hex(input.bearer)
    : input.pathToken !== undefined ? sha256hex(input.pathToken)
    : null;
  if (hash === null) return null;
  const kind = input.bearer !== undefined ? 'bearer' : 'path-only';
  for (const cred of store.credentials) {
    if (cred.kind !== kind || !timingEq(cred.secretSha256, hash)) continue;
    const principal = credUsable(cred, store);
    if (principal) return { principal, credential: cred };
  }
  return null;
}

// Rechecked immediately before every dispatch: a request admitted before a revoke
// must not execute after it.
export function credentialValid(store: Store, credentialId: string): boolean {
  const cred = store.credentials.find((c) => c.id === credentialId);
  return cred !== undefined && credUsable(cred, store) !== null;
}

export interface MintOpts {
  name: string;
  kind: 'bearer' | 'path-only';
  tools: string[] | 'all';
  allowSharedHistory?: boolean;
  ratePerMinute?: number;
}

// Returns the plaintext secret exactly once — it exists only in this return value
// and the caller's output; the store keeps only the hash.
export function mint(store: Store, opts: MintOpts): { principal: Principal; credential: Credential; secret: string } {
  if (opts.ratePerMinute !== undefined && (!Number.isSafeInteger(opts.ratePerMinute) || opts.ratePerMinute < 1)) {
    throw new Error('rate must be a positive integer');
  }
  const secret = newSecret();
  const principal: Principal = {
    id: newId('prin'),
    name: opts.name,
    enabled: true,
    tools: opts.tools,
    allowSharedHistory: opts.allowSharedHistory ?? false,
    ratePerMinute: opts.ratePerMinute ?? 60,
  };
  const credential: Credential = {
    id: newId('cred'),
    principalId: principal.id,
    kind: opts.kind,
    secretSha256: sha256hex(secret),
    createdAt: new Date().toISOString(),
  };
  store.principals.push(principal);
  store.credentials.push(credential);
  return { principal, credential, secret };
}

export function rotate(store: Store, principalId: string, graceMs: number): { credential: Credential; secret: string } | null {
  const principal = store.principals.find((p) => p.id === principalId && p.enabled);
  if (!principal) return null;
  const expiry = new Date(Date.now() + graceMs).toISOString();
  let kind: Credential['kind'] = 'bearer';
  for (const cred of store.credentials) {
    if (cred.principalId === principalId && cred.expiresAt === undefined) {
      cred.expiresAt = expiry;
      kind = cred.kind;
    }
  }
  const secret = newSecret();
  const credential: Credential = {
    id: newId('cred'),
    principalId,
    kind,
    secretSha256: sha256hex(secret),
    createdAt: new Date().toISOString(),
  };
  store.credentials.push(credential);
  return { credential, secret };
}

export function revoke(store: Store, principalId: string): boolean {
  const principal = store.principals.find((p) => p.id === principalId);
  if (!principal) return false;
  principal.enabled = false;
  return true;
}

// For display: identifiers and metadata, never secret hashes.
export function describe(store: Store): object[] {
  return store.principals.map((p) => ({
    principalId: p.id,
    name: p.name,
    enabled: p.enabled,
    tools: p.tools,
    allowSharedHistory: p.allowSharedHistory,
    ratePerMinute: p.ratePerMinute,
    credentials: store.credentials
      .filter((c) => c.principalId === p.id)
      .map((c) => ({ id: c.id, kind: c.kind, createdAt: c.createdAt, expiresAt: c.expiresAt })),
  }));
}
