import crypto from 'node:crypto';
import { ErrorCode, McpError, type CompatibilityCallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';

const PAGE_BYTES = 12 * 1024;
const INLINE_BYTES = 16 * 1024;
type Result = CompatibilityCallToolResult;
type Entry = { principal: string; tool: string; blocks: Buffer[]; bytes: number; expires: number };

export const readResultTool: Tool = {
  name: 'read_relay_result',
  description: 'Read an exact UTF-8 text page from a large result retained by this relay, without rerunning its original command. Use resultId from the preview, contentIndex (default 0), and offset (default 0, byte offset; follow nextOffset). Results expire after one hour, may be evicted earlier under memory pressure, and are lost on daemon restart. Only the original principal with the source tool still granted can read them. Unavailable output does not mean a command failed; do not automatically replay it.',
  inputSchema: { type: 'object', properties: {
    resultId: { type: 'string' }, contentIndex: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 },
  }, required: ['resultId'], additionalProperties: false },
  annotations: { title: 'Read retained result', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export function resultBytes(result: Result): { resultBytes: number; textBytes: number; structuredBytes: number; metaBytes: number } {
  return {
    resultBytes: Buffer.byteLength(JSON.stringify(result)),
    textBytes: Array.isArray(result.content) ? result.content.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0) : 0,
    structuredBytes: result.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent)),
    metaBytes: result._meta === undefined ? 0 : Buffer.byteLength(JSON.stringify(result._meta)),
  };
}

function page(buffer: Buffer, offset: number, length: number): { text: string; nextOffset: number | null } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length || (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80)) {
    throw new McpError(ErrorCode.InvalidParams, 'offset must be a valid UTF-8 byte boundary');
  }
  let end = Math.min(offset + length, buffer.length);
  while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(offset, end).toString('utf8'), nextOffset: end < buffer.length ? end : null };
}

export class ResultStore {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private maxBytes: number;
  private now: () => number;

  constructor(maxBytes = 64 * 1024 * 1024, now = Date.now) {
    this.maxBytes = maxBytes;
    this.now = now;
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  private prune(): void {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
  }

  compact(principal: string, tool: string, result: Result): Result {
    this.prune();
    if (result.structuredContent !== undefined || !Array.isArray(result.content) || result.content.some((c) => c.type !== 'text' || c.annotations !== undefined)) return result;
    const blocks = result.content.map((c) => Buffer.from(c.type === 'text' ? c.text : '', 'utf8'));
    const bytes = blocks.reduce((sum, block) => sum + block.length, 0);
    if (bytes <= INLINE_BYTES || bytes > this.maxBytes / 2) return result;
    // One principal cannot consume more than half the shared cache.
    let principalBytes = [...this.entries.values()].filter((e) => e.principal === principal).reduce((sum, e) => sum + e.bytes, 0);
    for (const [id, entry] of this.entries) {
      if (principalBytes + bytes <= this.maxBytes / 2) break;
      if (entry.principal === principal) { principalBytes -= entry.bytes; this.remove(id); }
    }
    while (this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    const resultId = crypto.randomUUID();
    const expires = this.now() + 60 * 60 * 1000;
    this.entries.set(resultId, { principal, tool, blocks, bytes, expires });
    this.bytes += bytes;
    const preview = page(blocks[0], 0, 4096).text;
    return { ...result, content: [{ type: 'text', text: `Large output retained by Desktop Relay (${bytes} UTF-8 bytes, ${blocks.length} text blocks). This is a preview, not the complete result.\nresultId: ${resultId}\nRead exact pages with read_relay_result, starting contentIndex=0, offset=0; use nextOffset and then the next contentIndex. Expires ${new Date(expires).toISOString()}, possibly earlier under memory pressure or restart. The original tool has already run; retrieval never re-executes it.\n\nFirst-block preview:\n${preview}` }] };
  }

  read(principal: string, grants: Set<string>, args: Record<string, unknown>): Result {
    this.prune();
    const entry = typeof args.resultId === 'string' ? this.entries.get(args.resultId) : undefined;
    if (!entry || entry.principal !== principal || !grants.has(entry.tool)) throw new McpError(ErrorCode.InvalidParams, 'retained result unavailable; do not automatically rerun the original command');
    const index = args.contentIndex ?? 0;
    const offset = args.offset ?? 0;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= entry.blocks.length || typeof offset !== 'number') throw new McpError(ErrorCode.InvalidParams, 'invalid contentIndex or offset');
    const output = page(entry.blocks[index], offset, PAGE_BYTES);
    return { content: [{ type: 'text', text: output.text }], structuredContent: {
      resultId: args.resultId, contentIndex: index, contentBlocks: entry.blocks.length,
      offset, nextOffset: output.nextOffset, totalBytes: entry.blocks[index].length,
      expiresAt: new Date(entry.expires).toISOString(),
    } };
  }

  revoke(principal: string): void {
    for (const [id, entry] of this.entries) if (entry.principal === principal) this.remove(id);
  }
}
