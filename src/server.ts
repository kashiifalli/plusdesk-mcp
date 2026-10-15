import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PlusDeskClient } from './client.js';
import type { Config } from './config.js';
import { Resolver } from './resolvers.js';
import { registerContextTools } from './tools/context.js';
import { registerInsightTools } from './tools/insights.js';
import { registerMoveTools } from './tools/move.js';
import type { Ctx } from './tools/registry.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerTimeTools } from './tools/time.js';

export function createServer(cfg: Config): McpServer {
  const api = new PlusDeskClient(cfg);
  const ctx: Ctx = { api, resolve: new Resolver(api), cfg };
  const server = new McpServer(
    { name: 'plusdesk-mcp', version: '0.1.0' },
    {
      instructions:
        'Tools for the PlusDesk (PulseDesk) project management tool. Refer to tickets by key (e.g. TICK-123), ' +
        'projects by key or name, and people by email or name — the server resolves IDs. ' +
        'Use plusdesk_get_project to discover boards/columns, plusdesk_list_next_statuses before moving status. ' +
        'PlusDesk AI auto-triage may change priority/labels a few seconds after a ticket is created; re-read with plusdesk_get_task if exact values matter. ' +
        'Destructive tools need confirm=true: ask the user first. All actions run with the configured user\'s own permissions.',
    },
  );
  registerContextTools(server, ctx);
  registerTaskTools(server, ctx);
  registerMoveTools(server, ctx);
  registerTimeTools(server, ctx);
  registerInsightTools(server, ctx);
  return server;
}
