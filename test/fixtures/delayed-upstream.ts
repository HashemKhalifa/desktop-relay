import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'delayed-upstream', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  while (!fs.existsSync(process.argv[2])) await setTimeout(20);
  return { tools: [{ name: 'fixture_ready', inputSchema: { type: 'object' } }] };
});
await server.connect(new StdioServerTransport());
