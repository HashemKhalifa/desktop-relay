import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
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

function grantedResourceUris(ctx: SessionCtx, grants: Set<string>): Set<string> {
  const uris = new Set<string>();
  for (const tool of ctx.upstream.toolInventory()) {
    if (!grants.has(tool.name)) continue;
    const meta = tool._meta as Record<string, unknown> | undefined;
    const ui = meta?.ui as Record<string, unknown> | undefined;
    for (const uri of [meta?.['ui/resourceUri'], meta?.['openai/outputTemplate'], ui?.resourceUri]) {
      if (typeof uri === 'string') uris.add(uri);
    }
  }
  return uris;
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
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: ctx.upstream.toolInventory().filter((t) => session.grants.has(t.name)).map((tool) =>
      tool.name === 'start_process' ? {
        ...tool,
        description: 'Run a shell command or start an interactive process on the connected Mac. Commands can read or modify files, access the network, and launch programs with the server user’s permissions. Use absolute paths; change directory within the command when needed. timeout_ms controls how long to wait for initial output; a process may continue running afterward. The result includes process state and output. Use read_process_output to read further output and interact_with_process to send input to an interactive process. shell selects the shell. verbose_timing includes timing diagnostics. For node:local, use ES imports and put the code in one call.',
      } : tool),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => {
    const { client, generation } = ctx.upstream.getClient();
    const page = await client.listResources(req.params ?? {}, { signal: extra.signal, timeout: ctx.rpcDeadlineMs });
    if (generation !== ctx.upstream.generation) throw new McpError(ErrorCode.InvalidRequest, 'upstream changed');
    const allowed = grantedResourceUris(ctx, session.grants);
    return { ...page, resources: page.resources.filter((resource) => allowed.has(resource.uri)) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    if (!grantedResourceUris(ctx, session.grants).has(req.params.uri)) {
      throw new McpError(ErrorCode.InvalidRequest, 'resource not available');
    }
    const { client, generation } = ctx.upstream.getClient();
    const result = await client.readResource(req.params, { signal: extra.signal, timeout: ctx.rpcDeadlineMs });
    if (generation !== ctx.upstream.generation) throw new McpError(ErrorCode.InvalidRequest, 'upstream changed');
    return result;
  });

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
