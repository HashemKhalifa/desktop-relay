import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type UpstreamState = 'down' | 'starting' | 'running' | 'dead';

const RESPAWN_BASE_MS = 250;
const RESPAWN_MAX_MS = 5000;

// Owns the one Desktop Commander child and the relay's single SDK Client.
// The client initializes the child as the relay — remote clients never negotiate
// upstream. One child shared by all sessions is the "one device" semantic the
// vendor relay provides; terminal state lives in this process, not per session.
export class Upstream {
  state: UpstreamState = 'down';
  generation = 0;
  private client: Client | null = null;
  private tools: Tool[] = [];
  private respawnDelay = RESPAWN_BASE_MS;
  private respawnTimer: NodeJS.Timeout | null = null;
  onstatechange?: (state: UpstreamState, generation: number) => void;

  private command: string;
  private args: string[];
  private cwd: string;
  private version: string;

  constructor(command: string, args: string[], cwd: string, version: string) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.version = version;
  }

  private setState(s: UpstreamState) {
    this.state = s;
    this.onstatechange?.(s, this.generation);
  }

  toolInventory(): Tool[] {
    return this.tools;
  }

  async start(): Promise<void> {
    if (this.state !== 'down') throw new Error(`upstream already ${this.state}`);
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const generation = ++this.generation;
    this.setState('starting');
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...getDefaultEnvironment() },
      cwd: this.cwd,
      stderr: 'inherit',
    });
    const client = new Client(
      { name: 'desktop-relay', version: this.version },
      { capabilities: {} },
    );
    transport.onclose = () => {
      if (generation !== this.generation) return;
      this.client = null;
      this.setState('down');
      this.scheduleRespawn(generation);
    };
    try {
      await client.connect(transport);
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      if (generation !== this.generation) return;
      this.client = client;
      this.tools = tools;
      this.respawnDelay = RESPAWN_BASE_MS;
      this.setState('running');
    } catch {
      if (generation !== this.generation) return;
      this.setState('down');
      this.scheduleRespawn(generation);
    }
  }

  private scheduleRespawn(fromGeneration: number) {
    const delay = this.respawnDelay;
    this.respawnDelay = Math.min(this.respawnDelay * 2, RESPAWN_MAX_MS);
    this.respawnTimer = setTimeout(() => {
      if (this.state === 'down' && this.generation === fromGeneration) void this.spawn();
    }, delay);
    this.respawnTimer.unref();
  }

  // Callers hold the generation they dispatched on; a stale-generation result is a
  // late callback from a dead child and must not reach a live session.
  getClient(): { client: Client; generation: number } {
    if (this.state !== 'running' || this.client === null) {
      throw new Error('upstream unavailable');
    }
    return { client: this.client, generation: this.generation };
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    const client = this.client;
    this.client = null;
    this.setState('dead');
    if (client) await client.close().catch(() => {});
  }
}
