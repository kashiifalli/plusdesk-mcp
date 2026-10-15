import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PlusDeskClient } from '../client.js';
import type { Config } from '../config.js';
import { fail } from '../format.js';
import { ResolveError, type Resolver } from '../resolvers.js';

export interface Ctx {
  api: PlusDeskClient;
  resolve: Resolver;
  cfg: Config;
}

type Shape = z.ZodRawShape;
type Kind = 'read' | 'write' | 'destructive';

/**
 * Registers a tool with consistent annotations and error handling.
 * Write and destructive tools are not registered at all in read-only mode.
 */
export function defineTool<S extends Shape>(
  server: McpServer,
  ctx: Ctx,
  name: string,
  opts: { title: string; description: string; kind: Kind; input: S; idempotent?: boolean },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
) {
  if (ctx.cfg.readOnly && opts.kind !== 'read') return;
  server.registerTool(
    name,
    {
      title: opts.title,
      description: opts.description,
      inputSchema: opts.input,
      annotations: {
        title: opts.title,
        readOnlyHint: opts.kind === 'read',
        destructiveHint: opts.kind === 'destructive',
        idempotentHint: opts.idempotent ?? opts.kind === 'read',
        openWorldHint: true,
      },
    },
    (async (args: any) => {
      try {
        return await handler(args);
      } catch (err) {
        return fail(err);
      }
    }) as any,
  );
}

/** Shared parameter descriptions. */
export const P = {
  ticket: z.string().describe('Ticket key (e.g. TICK-123) or ticket UUID'),
  project: z.string().describe('Project key (e.g. IDAT12), name, or UUID'),
  user: z.string().describe('User email, display name, UUID, or "me"'),
  confirm: z.boolean().optional().describe('Must be true to perform this destructive action. Ask the user first.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  limit: z.number().int().min(1).max(100).optional().describe('Max items to return (default 25)'),
};

export function requireConfirm(confirm: boolean | undefined, what: string) {
  if (!confirm) {
    throw new ResolveError(`Refusing to ${what} without confirm=true. Ask the user to confirm, then call again with confirm: true.`);
  }
}
