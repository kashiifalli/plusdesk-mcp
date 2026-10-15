#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const cfg = loadConfig();
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error(`plusdesk-mcp ready (tenant ${cfg.tenantSlug}${cfg.readOnly ? ', read-only' : ''})`);
}

main().catch((err) => {
  console.error(`plusdesk-mcp failed to start: ${err.message}`);
  process.exit(1);
});
