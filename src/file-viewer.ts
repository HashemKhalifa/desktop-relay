import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCode, McpError, type CompatibilityCallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { relayIcon } from './brand.ts';

export const fileViewerUri = 'ui://desktop-relay/file-viewer-v1.html';
export const browseFileTool: Tool = {
  name: 'browse_relay_file',
  description: 'Read a local file preview for the component. Requires read_file permission. File data is returned only in _meta.',
  inputSchema: { type: 'object', properties: {
    path: { type: 'string' }, offset: { type: 'integer', minimum: -200 }, length: { type: 'integer', minimum: 1, maximum: 200 },
  }, required: ['path'], additionalProperties: false },
  annotations: { title: 'Browse file', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
};

export const previewFileTool: Tool = {
  ...browseFileTool,
  name: 'preview_relay_file',
  description: 'Show an interactive local text-file preview only when the user explicitly asks to open or preview a file. Do not use for routine file reads, research, or task progress; use read_file to read content for reasoning. The card reads from disk only when the user opens it.',
  annotations: { ...browseFileTool.annotations, title: 'Preview file' },
  _meta: { ui: { resourceUri: fileViewerUri, visibility: ['model'] }, 'ui/resourceUri': fileViewerUri,
    'openai/outputTemplate': fileViewerUri },
};

export function withFileViewer(tool: Tool): Tool {
  if (tool.name !== 'read_file') return tool;
  // Upstream also advertises a file widget. Strip every renderer alias so a
  // routine read cannot open either viewer when ChatGPT restores the chat.
  const meta = { ...tool._meta };
  delete meta['ui/resourceUri'];
  delete meta['openai/outputTemplate'];
  delete meta['openai/widgetAccessible'];
  if (meta.ui && typeof meta.ui === 'object') {
    const ui = { ...meta.ui as Record<string, unknown> };
    delete ui.resourceUri;
    if (Object.keys(ui).length) meta.ui = ui;
    else delete meta.ui;
  }
  return { ...tool, _meta: meta };
}

export function fileViewerResource() {
  const css = fs.readFileSync(new URL('./file-viewer.css', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('./file-viewer.bundle.js', import.meta.url), 'utf8');
  const template = fs.readFileSync(new URL('./file-viewer.html', import.meta.url), 'utf8');
  return { contents: [{ uri: fileViewerUri, mimeType: 'text/html;profile=mcp-app',
    text: template.replace('<!-- styles -->', () => `<style>${css}</style>`).replace('<!-- script -->', () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`).replaceAll('{{icon}}', relayIcon),
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/widgetDescription': 'Compact local file card. Open to browse read-only ranges without adding file contents to the conversation.',
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] } },
  }] };
}

export function fileReadArgs(args: Record<string, unknown>) {
  const { path: filePath, offset = 0, length = 200 } = args;
  if (Object.keys(args).some(key => !['path', 'offset', 'length'].includes(key))) throw new McpError(ErrorCode.InvalidParams, 'unsupported preview argument');
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new McpError(ErrorCode.InvalidParams, 'path must be an absolute local file path');
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < -200) throw new McpError(ErrorCode.InvalidParams, 'offset must be an integer, at least -200');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > 200) throw new McpError(ErrorCode.InvalidParams, 'length must be between 1 and 200');
  return { path: filePath, offset, length, origin: 'ui' };
}

export function fileViewResult(result: CompatibilityCallToolResult, args: ReturnType<typeof fileReadArgs>): CompatibilityCallToolResult {
  if (result.isError) return result;
  const content = result.content ?? [];
  // Images arrive as base64 text on upstream UI reads; never render that as source.
  if (result.structuredContent?.fileType === 'image' || content.some(block => block.type !== 'text')) {
    return { isError: true, content: [{ type: 'text', text: 'This viewer supports text and source files. Use the original read_file result for media.' }] };
  }
  const raw = content.map(block => block.type === 'text' ? block.text : '').join('\n');
  if (Buffer.byteLength(raw) > 256 * 1024) return { isError: true, content: [{ type: 'text', text: 'This range exceeds the 256 KiB preview limit. Choose fewer lines.' }] };
  const header = raw.match(/^\[Reading (?:last )?(\d+) lines(?: from (?:start|line \d+))?(?: \(total: (\d+) lines(?:, \d+ remaining)?\))?\]\r?\n(?:\r?\n)?/);
  const text = header ? raw.slice(header[0].length) : raw;
  const totalLines = header?.[2] === undefined ? null : Number(header[2]);
  const readLines = header ? Number(header[1]) : null;
  const offset = args.offset < 0 && totalLines !== null ? Math.max(0, totalLines + args.offset) : args.offset;
  const firstLine = header && offset >= 0 ? offset + 1 : null;
  const nextOffset = header && offset >= 0 && readLines !== null && readLines > 0 && (totalLines === null ? readLines >= args.length : offset + readLines < totalLines) ? offset + readLines : null;
  return {
    content: [{ type: 'text', text: 'File preview loaded. Display content is available to the component.' }],
    _meta: { fileView: { path: args.path, text, firstLine, readLines, totalLines, nextOffset,
      hash: crypto.createHash('sha256').update(text).digest('hex'), readAt: new Date().toISOString() } },
  };
}
