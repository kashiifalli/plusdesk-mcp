/**
 * End-to-end smoke test: spawns the MCP server over stdio and drives every tool
 * against a sandbox project. Usage: npx tsx scripts/e2e.ts <PROJECT_KEY>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = process.argv[2] ?? 'IDAT12';
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: process.env.E2E_DIST ? 'node' : 'npx', args: process.env.E2E_DIST ? ['dist/index.js'] : ['tsx', 'src/index.ts'], stderr: 'inherit' }));

let failures = 0;
async function call(name: string, args: Record<string, unknown> = {}, expectError = false) {
  const res: any = await client.callTool({ name, arguments: args });
  const text: string = res.content?.[0]?.text ?? '';
  const bad = !!res.isError !== expectError;
  if (bad) failures++;
  console.log(`${bad ? '✗' : '✓'} ${name}${expectError ? ' (expect error)' : ''}: ${text.split('\n')[0].slice(0, 200)}`);
  return text;
}
const json = (t: string) => JSON.parse(t.slice(t.indexOf('\n\n') + 2));

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name.replace('plusdesk_', '')).join(', ')}\n`);

await call('plusdesk_whoami');
await call('plusdesk_list_projects');
await call('plusdesk_get_project', { project });
await call('plusdesk_find_users', { search: 'ali', project });

const created = json(await call('plusdesk_create_task', {
  project, title: '[MCP-E2E] Parse import documents', type: 'task', priority: 'high', assignee: 'me',
  description: 'Created by the MCP end-to-end test', estimated_hours: 6, due_date: '2026-10-31',
  start_at: '2026-10-16T09:00:00Z', end_at: '2026-10-24T18:00:00Z', story_points: 5, labels: ['mcp-e2e'], column: 'To Do',
}));
const key = created.key;
await call('plusdesk_create_task', { project, title: 'bad', type: 'bug' }, true);
await call('plusdesk_create_task', { project, title: 'bad', story_points: 4 }, true);

await call('plusdesk_create_subtask', { parent: key, title: '[MCP-E2E] child ticket', assignee: 'me', estimated_hours: 2 });
await call('plusdesk_create_subtask', { parent: key, title: 'Write unit tests', mode: 'checklist', end_at: '2026-10-20T18:00:00Z' });
await call('plusdesk_update_checklist_item', { ticket: key, item: 'unit tests', status: 'done' });
await call('plusdesk_update_task', { ticket: key, description: 'Filled in via MCP: parse PDFs, extract fields, validate.', acceptance_criteria: '- PDFs parsed\n- Fields validated' });
await call('plusdesk_assign_task', { tickets: [key], assignee: 'kashif.ali@virtuosoft.pk' });
await call('plusdesk_add_comment', { ticket: key, body: 'Comment from MCP e2e' });
await call('plusdesk_list_next_statuses', { ticket: key });
await call('plusdesk_move_task', { ticket: key, status: 'Nonexistent Status' }, true);
await call('plusdesk_move_task', { ticket: key, status: 'In Progress' });
await call('plusdesk_move_task', { ticket: key, column: 'In Review' });
await call('plusdesk_move_task', { ticket: key, status: 'x', column: 'y' }, true);
await call('plusdesk_set_blocked', { ticket: key, blocked: true, reason: 'Waiting for sample documents' });
await call('plusdesk_set_blocked', { ticket: key, blocked: false });
const logged = json(await call('plusdesk_log_time', { ticket: key, hours: 1.25, description: 'E2E: initial parsing spike' }));
await call('plusdesk_update_worklog', { worklog_id: logged.id, hours: 1.5 });
await call('plusdesk_list_worklogs', { ticket: key });
await call('plusdesk_list_worklogs', {});
await call('plusdesk_get_task', { ticket: key, include: ['subitems', 'subtasks', 'comments', 'worklogs', 'history'] });
await call('plusdesk_list_tasks', { project, label: 'mcp-e2e' });
await call('plusdesk_search', { query: key });
await call('plusdesk_delete_task', { ticket: key }, true);
await call('plusdesk_my_work');
await call('plusdesk_project_insights', { project });
await call('plusdesk_team_workload', { project });
await call('plusdesk_time_report', { project });
await call('plusdesk_flow_analytics', { project, metric: 'cycle-time' });
await call('plusdesk_activity', { ticket: key, limit: 5 });
await call('plusdesk_list_sprints', { project });

console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'} — test ticket ${key}`);
await client.close();
process.exit(failures ? 1 : 0);
