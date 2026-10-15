/** Removes worklogs created by e2e/probe runs on [MCP-*] tickets in a project. Usage: npx tsx scripts/cleanup-e2e.ts IDAT12 */
import { PlusDeskClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { listOf } from '../src/format.js';
import { Resolver } from '../src/resolvers.js';

const api = new PlusDeskClient(loadConfig());
const projectId = await new Resolver(api).projectId(process.argv[2] ?? 'IDAT12');
const tickets = listOf(await api.get('/tickets', { projectId, search: '[MCP-', limit: 100 }));
for (const t of tickets.filter((t) => t.title.startsWith('[MCP-'))) {
  for (const w of listOf(await api.get(`/tickets/${t.id}/worklogs`))) {
    await api.delete(`/tickets/worklogs/${w.id}`);
    console.log(`deleted ${w.hours_spent ?? '?'}h worklog on ${t.ticket_number}`);
  }
}
console.log('test tickets left (need an admin to delete):', tickets.filter((t) => t.title.startsWith('[MCP-')).map((t) => t.ticket_number).join(', '));
