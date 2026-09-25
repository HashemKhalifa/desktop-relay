import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { credentialValid, type Credential, type Principal, type Store } from './creds.ts';
import { grantedToolNames } from './policy.ts';
import type { Upstream } from './upstream.ts';

export interface Session {
  id: string | undefined;
  transport: StreamableHTTPServerTransport;
  server: Server;
  principalId: string;
  credentialId: string;
  generation: number;
  createdAt: number;
  grants: Set<string>;
}

export interface SessionCtx {
  upstream: Upstream;
  storeRef: { current: Store };
  sessions: Map<string, Session>;
  version: string;
  rpcDeadlineMs: number;
  maxSessions: number;
  audit: (event: string, fields: Record<string, unknown>) => void;
}

// One SDK Server + transport per downstream protocol session. The relay owns
// negotiation: each remote client initializes against this Server instance; the
// shared upstream Client's identity is never touched by them. Cancellation and
// progress route correctly by construction — the SDK aborts this handler's signal
// and surfaces upstream progress only to this session's transport.
export function createSession(ctx: SessionCtx, principal: Principal, credential: Credential): Session | null {
  if (ctx.upstream.state !== 'running' || ctx.sessions.size >= ctx.maxSessions) return null;

  const session: Session = {
    id: undefined,
    transport: undefined as unknown as StreamableHTTPServerTransport,
    server: undefined as unknown as Server,
    principalId: principal.id,
    credentialId: credential.id,
    generation: ctx.upstream.generation,
    createdAt: Date.now(),
    grants: grantedToolNames(principal, ctx.upstream.toolInventory().map((t) => t.name)),
  };

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    keepAliveMs: 30_000,
    onsessioninitialized: (id) => {
      session.id = id;
      ctx.sessions.set(id, session);
      ctx.audit('session.open', { principalId: principal.id, credentialId: credential.id, sessionId: id, generation: session.generation });
    },
    onsessionclosed: (id) => {
      ctx.sessions.delete(id);
      ctx.audit('session.close', { sessionId: id });
    },
  });

  const server = new Server(
    { name: 'desktop-relay', version: ctx.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ctx.upstream.toolInventory().filter((t) => session.grants.has(t.name)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    if (session.generation !== ctx.upstream.generation || !credentialValid(ctx.storeRef.current, session.credentialId)) {
      closeSession(ctx, session);
      throw new McpError(ErrorCode.InvalidRequest, 'session invalid; re-initialize');
    }
    if (!session.grants.has(name)) {
      ctx.audit('tool.denied', { principalId: session.principalId, credentialId: session.credentialId, sessionId: session.id, tool: name });
      throw new McpError(ErrorCode.MethodNotFound, 'tool not available');
    }
    const { client, generation } = ctx.upstream.getClient();
    const started = Date.now();
    ctx.audit('tool.call', { principalId: session.principalId, credentialId: session.credentialId, sessionId: session.id, generation, tool: name });
    const progressToken = (req.params._meta as { progressToken?: string | number } | undefined)?.progressToken;
    const result = await client.request(
      { method: 'tools/call', params: req.params },
      CompatibilityCallToolResultSchema,
      {
        timeout: ctx.rpcDeadlineMs,
        maxTotalTimeout: ctx.rpcDeadlineMs,
        resetTimeoutOnProgress: true,
        signal: extra.signal,
        onprogress: progressToken === undefined
          ? undefined
          : (p) => {
              void extra.sendNotification({
                method: 'notifications/progress',
                params: { ...p, progressToken },
              }).catch(() => {});
            },
      },
    );
    ctx.audit('tool.result', { principalId: session.principalId, sessionId: session.id, tool: name, ms: Date.now() - started });
    return result;
  });

  session.transport = transport;
  session.server = server;
  void server.connect(transport);
  return session;
}

export function closeSession(ctx: SessionCtx, session: Session): void {
  if (session.id !== undefined) ctx.sessions.delete(session.id);
  void session.transport.close().catch(() => {});
  void session.server.close().catch(() => {});
}
