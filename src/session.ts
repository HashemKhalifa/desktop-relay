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
import { describeTool } from './tool-descriptions.ts';
import { readResultTool, resultBytes, type ResultStore } from './results.ts';
import type { Upstream } from './upstream.ts';
import { browseFileTool, fileReadArgs, fileViewResult, fileViewerResource, fileViewerUri, previewFileTool, withFileViewer } from './file-viewer.ts';
import { relayIcons } from './brand.ts';

export interface Session {
  id: string | undefined;
  transport: StreamableHTTPServerTransport;
  server: Server;
  principalId: string;
  credentialId: string;
  generation: number;
  createdAt: number;
  lastActivity: number;
  activeRequests: number;
  grants: Set<string>;
}

export interface SessionCtx {
  upstream: Upstream;
  storeRef: { current: Store };
  sessions: Map<string, Session>;
  version: string;
  rpcDeadlineMs: number;
  maxSessions: number;
  results: ResultStore;
  audit: (event: string, fields: Record<string, unknown>) => void;
}

function grantedResourceUris(ctx: SessionCtx, grants: Set<string>): Set<string> {
  const uris = new Set<string>(grants.has('read_file') ? [fileViewerUri] : []);
  for (const tool of ctx.upstream.toolInventory()) {
    if (!grants.has(tool.name)) continue;
    const meta = withFileViewer(tool)._meta as Record<string, unknown> | undefined;
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
  if (ctx.upstream.state !== 'running') return null;
  if (ctx.sessions.size >= ctx.maxSessions) {
    const idle = [...ctx.sessions.values()]
      .filter((s) => s.activeRequests === 0 && Date.now() - s.lastActivity >= 60_000)
      .sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (!idle) return null;
    ctx.audit('session.evict', { sessionId: idle.id, reason: 'capacity' });
    closeSession(ctx, idle);
  }

  const session: Session = {
    id: undefined,
    transport: undefined as unknown as StreamableHTTPServerTransport,
    server: undefined as unknown as Server,
    principalId: principal.id,
    credentialId: credential.id,
    generation: ctx.upstream.generation,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    activeRequests: 0,
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
    { name: 'desktop-relay', title: 'Desktop Relay', version: ctx.version, icons: relayIcons },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...ctx.upstream.toolInventory().filter((t) => session.grants.has(t.name)).map(describeTool).map(withFileViewer), ...(session.grants.size ? [readResultTool] : []), ...(session.grants.has('read_file') ? [previewFileTool, browseFileTool] : [])],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async (req, extra) => {
    const { client, generation } = ctx.upstream.getClient();
    const page = await client.listResources(req.params ?? {}, { signal: extra.signal, timeout: ctx.rpcDeadlineMs });
    if (generation !== ctx.upstream.generation) throw new McpError(ErrorCode.InvalidRequest, 'upstream changed');
    const allowed = grantedResourceUris(ctx, session.grants);
    return { ...page, resources: [...page.resources.filter((resource) => allowed.has(resource.uri)), ...(session.grants.has('read_file') && !req.params?.cursor ? [{ uri: fileViewerUri, name: 'Desktop Relay file viewer', mimeType: 'text/html;profile=mcp-app' }] : [])] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    if (!grantedResourceUris(ctx, session.grants).has(req.params.uri)) {
      throw new McpError(ErrorCode.InvalidRequest, 'resource not available');
    }
    if (req.params.uri === fileViewerUri) return fileViewerResource();
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
    if (name === readResultTool.name) {
      const result = ctx.results.read(session.principalId, session.grants, req.params.arguments ?? {});
      ctx.audit('result.read', { principalId: session.principalId, ...resultBytes(result) });
      return result;
    }
    const browsing = name === browseFileTool.name;
    const previewing = name === previewFileTool.name;
    if (!session.grants.has(browsing || previewing ? 'read_file' : name)) {
      ctx.audit('tool.denied', { principalId: session.principalId, credentialId: session.credentialId, sessionId: session.id, tool: name });
      throw new McpError(ErrorCode.MethodNotFound, 'tool not available');
    }
    if (previewing) {
      fileReadArgs(req.params.arguments ?? {});
      const card = { content: [{ type: 'text' as const, text: 'File preview ready. Open the card to browse the file. Use read_file if file contents are needed for reasoning.' }] };
      ctx.audit('tool.call', { principalId: session.principalId, credentialId: session.credentialId, sessionId: session.id, generation: session.generation, tool: name, audience: 'model' });
      ctx.audit('tool.result', { principalId: session.principalId, sessionId: session.id, tool: name, audience: 'model', ...resultBytes(card), isError: false });
      return card;
    }
    const viewArgs = browsing ? fileReadArgs(req.params.arguments ?? {}) : undefined;
    const audience = browsing ? 'app' : req.params.arguments?.origin === 'ui' ? 'legacy-ui' : 'model';
    const { client, generation } = ctx.upstream.getClient();
    const started = Date.now();
    ctx.audit('tool.call', { principalId: session.principalId, credentialId: session.credentialId, sessionId: session.id, generation, tool: name, audience });
    const progressToken = (req.params._meta as { progressToken?: string | number } | undefined)?.progressToken;
    const result = await client.request(
      { method: 'tools/call', params: browsing ? { ...req.params, name: 'read_file', arguments: viewArgs } : req.params },
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
    if (generation !== ctx.upstream.generation || !credentialValid(ctx.storeRef.current, session.credentialId)) throw new McpError(ErrorCode.InvalidRequest, 'session changed; re-initialize. The command outcome may be unknown; do not replay it.');
    const output = viewArgs ? fileViewResult(result, viewArgs) : req.params.arguments?.origin === 'ui' || ctx.upstream.toolInventory().find((t) => t.name === name)?.outputSchema
      ? result : ctx.results.compact(session.principalId, name, result);
    const originalSize = resultBytes(result);
    ctx.audit('tool.result', {
      principalId: session.principalId, sessionId: session.id, tool: name, audience, ms: Date.now() - started,
      ...(output === result ? originalSize : resultBytes(output)), originalBytes: originalSize.resultBytes,
      argumentBytes: Buffer.byteLength(JSON.stringify(req.params.arguments ?? {})),
      offloaded: !browsing && output !== result, isError: output.isError === true,
    });
    return output;
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
