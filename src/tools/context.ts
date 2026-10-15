import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compact, listOf, ok, subitem, ticket, worklog } from '../format.js';
import { defineTool, P, type Ctx } from './registry.js';

export function registerContextTools(server: McpServer, ctx: Ctx) {
  const { api, resolve } = ctx;

  defineTool(server, ctx, 'plusdesk_whoami', {
    title: 'Who am I',
    description: 'Show the PlusDesk user these credentials act as (name, email, roles).',
    kind: 'read',
    input: {},
  }, async () => {
    const me = await resolve.me();
    return ok(`Signed in as ${me.displayName} <${me.email}> (roles: ${me.roles?.join(', ') || 'none'})`, compact(me));
  });

  defineTool(server, ctx, 'plusdesk_list_projects', {
    title: 'List projects',
    description: 'List the projects visible to you, with their keys. Use the key or name in other tools.',
    kind: 'read',
    input: {},
  }, async () => {
    const projects = await resolve.projects();
    return ok(`${projects.length} projects`, projects.map((p) => compact({
      id: p.id, key: p.key, name: p.name, status: p.status, methodology: p.methodology, type: p.project_type,
    })));
  });

  defineTool(server, ctx, 'plusdesk_get_project', {
    title: 'Get project',
    description: 'Project details: members, boards with their columns, allowed ticket types, and summary stats.',
    kind: 'read',
    input: { project: P.project },
  }, async ({ project }) => {
    const p = await resolve.project(project);
    const [detail, members, config, stats, boards] = await Promise.all([
      api.get(`/projects/${p.id}`),
      api.get(`/projects/${p.id}/members`),
      api.get(`/projects/${p.id}/config`),
      api.get(`/projects/${p.id}/stats`).catch(() => undefined),
      resolve.boards(p.id),
    ]);
    const boardDetails = await Promise.all(boards.map((b) => resolve.boardDetail(b.id)));
    return ok(`Project ${detail.key} — ${detail.name}`, {
      project: compact({
        id: detail.id, key: detail.key, name: detail.name, description: detail.description, status: detail.status,
        methodology: detail.methodology, timezone: detail.timezone,
      }),
      allowed_ticket_types: config.ticketTypes,
      members: listOf(members).map((m) => ({ user_id: m.user_id, name: m.display_name, email: m.email, role: m.role })),
      boards: boardDetails.map((b) => ({
        id: b.id, name: b.name, type: b.type,
        columns: (b.columns ?? []).map((c: any) => ({ id: c.id, name: c.name, tickets: c.tickets?.length ?? 0, wip_limit: c.wip_limit ?? undefined })),
      })),
      stats: stats && compact({
        blocked: stats.blockedCount, overdue: stats.overdueCount, by_status: stats.ticketsByStatus,
        by_member: stats.ticketsByMember, active_sprint: stats.activeSprint, open_risks: stats.riskSummary?.openCount,
      }),
    });
  });

  defineTool(server, ctx, 'plusdesk_find_users', {
    title: 'Find users',
    description: 'Search users by name or email, optionally limited to people assignable in a project.',
    kind: 'read',
    input: {
      search: z.string().optional().describe('Part of a name or email'),
      project: P.project.optional(),
    },
  }, async ({ search, project }) => {
    const projectId = project ? await resolve.projectId(project) : undefined;
    const users = await api.get<any[]>('/users', { search, projectId, assignableOnly: projectId ? 'true' : undefined });
    return ok(`${users.length} users`, users.map((u) => ({ id: u.id, name: u.displayName, email: u.email, status: u.status })));
  });

  defineTool(server, ctx, 'plusdesk_list_sprints', {
    title: 'List sprints',
    description: 'List sprints for a project board, or all planning/active sprints on your boards.',
    kind: 'read',
    input: { project: P.project.optional(), board: z.string().optional().describe('Board name or id') },
  }, async ({ project, board }) => {
    let res;
    if (project) {
      const b = await resolve.board(await resolve.projectId(project), board);
      res = await api.get(`/boards/${b.id}/sprints`);
    } else {
      res = await api.get('/sprints');
    }
    const sprints = listOf(res);
    return ok(`${sprints.length} sprints`, sprints.map((s) => compact({
      id: s.id, name: s.name, status: s.status, goal: s.goal, start: s.start_date, end: s.end_date, board_id: s.board_id,
    })));
  });

  defineTool(server, ctx, 'plusdesk_search', {
    title: 'Search',
    description: 'Global search across tickets, projects and articles you can see. Matches titles and ticket keys.',
    kind: 'read',
    input: { query: z.string().min(2), limit: P.limit },
  }, async ({ query, limit }) => {
    const hits = await api.get<any[]>('/search', { q: query, limit: limit ?? 25 });
    return ok(`${hits.length} results`, hits.map((h) => compact({ type: h.type, id: h.id, title: h.title, subtitle: h.subtitle })));
  });

  defineTool(server, ctx, 'plusdesk_list_tasks', {
    title: 'List tasks',
    description: 'List tickets with filters. Combine filters freely; results are paginated.',
    kind: 'read',
    input: {
      project: P.project.optional(),
      assignee: P.user.optional(),
      reporter: P.user.optional(),
      status: z.string().optional().describe('Status slug, e.g. in_progress, in_review, done'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
      type: z.enum(['bug', 'feature_request', 'task', 'sub_task', 'incident', 'change_request', 'support_request', 'epic', 'story', 'spike']).optional(),
      parent: P.ticket.optional().describe('List children (sub-tasks) of this ticket'),
      sprint: z.string().optional().describe('Sprint id or name'),
      label: z.string().optional().describe('Label (comma-separated for several)'),
      overdue: z.boolean().optional(),
      due_from: P.date.optional(),
      due_to: P.date.optional(),
      search: z.string().optional().describe('Text in title or description'),
      sort_by: z.string().optional().describe('e.g. updated_at, due_date, priority, created_at'),
      sort_order: z.enum(['asc', 'desc']).optional(),
      page: z.number().int().min(1).optional(),
      limit: P.limit,
    },
  }, async (a) => {
    const projectId = a.project ? await resolve.projectId(a.project) : undefined;
    const res = await api.get('/tickets', {
      projectId,
      assigneeId: a.assignee ? await resolve.userId(a.assignee, projectId) : undefined,
      reporterId: a.reporter ? await resolve.userId(a.reporter, projectId) : undefined,
      parentId: a.parent ? await resolve.ticketId(a.parent) : undefined,
      sprintId: a.sprint ? await resolve.sprintId(a.sprint) : undefined,
      status: a.status, priority: a.priority, type: a.type, label: a.label, overdue: a.overdue,
      dueDateFrom: a.due_from, dueDateTo: a.due_to, search: a.search,
      sortBy: a.sort_by, sortOrder: a.sort_order, page: a.page ?? 1, limit: a.limit ?? 25,
    });
    const rows = listOf(res);
    return ok(`${rows.length} of ${res.total ?? rows.length} tickets (page ${res.page ?? 1}/${res.totalPages ?? 1})`, rows.map((t) => ticket(t)));
  });

  defineTool(server, ctx, 'plusdesk_get_task', {
    title: 'Get task',
    description: 'Full ticket detail, plus optional checklist subitems, sub-tasks, comments, worklogs, links and change history.',
    kind: 'read',
    input: {
      ticket: P.ticket,
      include: z.array(z.enum(['subitems', 'subtasks', 'comments', 'worklogs', 'links', 'history'])).optional()
        .describe('Extra sections to load (default: subitems, subtasks)'),
    },
  }, async ({ ticket: ref, include }) => {
    const id = await resolve.ticketId(ref);
    const inc = new Set(include ?? ['subitems', 'subtasks']);
    const t = await api.get(`/tickets/${id}`);
    const out: Record<string, unknown> = { ticket: ticket(t, true) };
    const loads: Promise<void>[] = [];
    const load = (key: string, fn: () => Promise<unknown>) => loads.push(fn().then((v) => { out[key] = v; }, (e) => { out[key] = `unavailable: ${e.message}`; }));
    if (inc.has('subitems')) load('checklist', async () => listOf(await api.get(`/tickets/${id}/subitems`)).map(subitem));
    if (inc.has('subtasks')) load('subtasks', async () => listOf(await api.get('/tickets', { parentId: id, limit: 100 })).map((c) => ticket(c)));
    if (inc.has('comments')) load('comments', async () => listOf(await api.get(`/tickets/${id}/comments`)).map((c) => compact({
      id: c.id, author: c.author_name ?? c.author_id, body: c.body, internal: c.is_internal || undefined, at: c.created_at,
    })));
    if (inc.has('worklogs')) load('worklogs', async () => listOf(await api.get(`/tickets/${id}/worklogs`)).map(worklog));
    if (inc.has('links')) load('links', async () => listOf(await api.get(`/tickets/${id}/links`)));
    if (inc.has('history')) load('history', async () => listOf(await api.get(`/tickets/${id}/history`)).slice(0, 50).map((h) => compact({
      field: h.field_name, from: h.old_value, to: h.new_value, by: h.changed_by_name, at: h.changed_at,
    })));
    await Promise.all(loads);
    return ok(`${t.ticket_number} — ${t.title} [${t.status}]`, out);
  });
}
