import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlusDeskClient } from '../client.js';
import { PlusDeskError } from '../client.js';
import { compact, listOf, ok, ticket } from '../format.js';
import { defineTool, P, type Ctx } from './registry.js';

const DONE = new Set(['done', 'closed', 'resolved', 'cancelled', 'canceled', 'rejected', 'released']);
const isOpen = (t: any) => !DONE.has(t.status) && !t.completed_at && !t.closed_at;
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Call an endpoint that some roles may not access; returns a note instead of failing. */
async function optional(fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlusDeskError && (e.status === 403 || e.status === 404)) return { unavailable: e.status === 403 ? 'not permitted for your role' : 'not found' };
    return { unavailable: (e as Error).message };
  }
}

/** Fetch up to `max` tickets matching the query, following pagination. */
async function allTickets(api: PlusDeskClient, query: Record<string, any>, max = 500): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; out.length < max; page++) {
    const res = await api.get('/tickets', { ...query, page, limit: 100 });
    const rows = listOf(res);
    out.push(...rows);
    if (rows.length < 100 || page >= (res.totalPages ?? page)) break;
  }
  return out;
}

const countBy = (rows: any[], key: (r: any) => string) =>
  rows.reduce<Record<string, number>>((acc, r) => ((acc[key(r)] = (acc[key(r)] ?? 0) + 1), acc), {});

/** Ticket-derived health summary that works for any role. */
export function summarizeTickets(tickets: any[], now = new Date()) {
  const open = tickets.filter(isOpen);
  const todayStr = isoDay(now);
  const weekAhead = isoDay(new Date(now.getTime() + 7 * DAY));
  const due = (t: any) => (t.due_date ? String(t.due_date).slice(0, 10) : undefined);
  const overdue = open.filter((t) => due(t) && due(t)! < todayStr);
  const dueSoon = open.filter((t) => due(t) && due(t)! >= todayStr && due(t)! <= weekAhead);
  const stale = open.filter((t) => t.updated_at && now.getTime() - new Date(t.updated_at).getTime() > 7 * DAY);
  const completedLast7 = tickets.filter((t) => t.completed_at && now.getTime() - new Date(t.completed_at).getTime() <= 7 * DAY);

  const byAssignee: Record<string, { open: number; overdue: number; blocked: number; estimated_hours: number }> = {};
  for (const t of open) {
    const k = t.assignee_name ?? t.assignee_email ?? (t.assignee_id ? t.assignee_id : 'Unassigned');
    const row = (byAssignee[k] ??= { open: 0, overdue: 0, blocked: 0, estimated_hours: 0 });
    row.open++;
    if (overdue.includes(t)) row.overdue++;
    if (t.blocked) row.blocked++;
    row.estimated_hours += Number(t.estimated_hours) || 0;
  }

  return {
    totals: {
      tickets: tickets.length,
      open: open.length,
      completed_last_7_days: completedLast7.length,
      overdue: overdue.length,
      due_next_7_days: dueSoon.length,
      blocked: open.filter((t) => t.blocked).length,
      unassigned: open.filter((t) => !t.assignee_id).length,
      stale_over_7_days: stale.length,
      open_estimated_hours: open.reduce((s, t) => s + (Number(t.estimated_hours) || 0), 0),
    },
    open_by_status: countBy(open, (t) => t.status),
    open_by_priority: countBy(open, (t) => t.priority ?? 'none'),
    open_by_type: countBy(open, (t) => t.type),
    workload_by_assignee: byAssignee,
    overdue: overdue.slice(0, 15).map((t) => ticket(t)),
    blocked: open.filter((t) => t.blocked).slice(0, 15).map((t) => ticket(t)),
    due_soon: dueSoon.slice(0, 15).map((t) => ticket(t)),
    stale: stale.slice(0, 10).map((t) => ticket(t)),
    high_priority_open: open.filter((t) => t.priority === 'critical' || t.priority === 'high').slice(0, 15).map((t) => ticket(t)),
  };
}

export function registerInsightTools(server: McpServer, ctx: Ctx) {
  const { api, resolve } = ctx;

  defineTool(server, ctx, 'plusdesk_my_work', {
    title: 'My work',
    description: 'Your personal dashboard: assigned, overdue, blocked, upcoming due, recently completed tickets.',
    kind: 'read',
    input: {},
  }, async () => {
    const [mine, dev] = await Promise.all([api.get('/dashboards/my-work'), optional(() => api.get('/dashboards/developer'))]);
    return ok(
      `${mine.stats?.assignedCount ?? mine.assigned?.length ?? 0} assigned, ${mine.overdueCount ?? 0} overdue, ${mine.blocked?.length ?? 0} blocked`,
      compact({ ...mine, developer_summary: dev }),
    );
  });

  defineTool(server, ctx, 'plusdesk_project_insights', {
    title: 'Project insights',
    description:
      'Health brief for a project: open work by status/priority/assignee, overdue, blocked, due soon, stale tickets, aging, ' +
      'board velocity and throughput, open risks, and the AI overview where your role allows it.',
    kind: 'read',
    input: { project: P.project, assignee: P.user.optional().describe('Limit the ticket analysis to one person') },
  }, async (a) => {
    const p = await resolve.project(a.project);
    const assigneeId = a.assignee ? await resolve.userId(a.assignee, p.id) : undefined;
    const boards = await resolve.boards(p.id);
    const [tickets, stats, aging, risks, overview, aiInsight, boardMetrics] = await Promise.all([
      allTickets(api, { projectId: p.id, assigneeId }),
      optional(() => api.get(`/projects/${p.id}/stats`)),
      optional(() => api.get(`/projects/${p.id}/analytics/aging`)),
      optional(() => api.get(`/projects/${p.id}/risks`)),
      optional(() => api.get(`/projects/${p.id}/overview`)),
      optional(() => api.get(`/projects/${p.id}/overview/ai-insight`)),
      Promise.all(boards.map(async (b) => ({
        board: b.name,
        velocity: await optional(() => api.get(`/boards/${b.id}/velocity`)),
        throughput: await optional(() => api.get(`/boards/${b.id}/throughput`)),
      }))),
    ]);
    const summary = summarizeTickets(tickets);
    const riskList = (Array.isArray(risks) ? risks : listOf(risks)).filter((r: any) => !['closed', 'realized'].includes(r.status));
    return ok(
      `${p.key ?? p.name}: ${summary.totals.open} open, ${summary.totals.overdue} overdue, ${summary.totals.blocked} blocked, ${summary.totals.completed_last_7_days} done in last 7 days`,
      compact({
        project: { id: p.id, key: p.key, name: p.name },
        ...summary,
        aging: aging?.buckets ?? aging,
        boards: boardMetrics,
        active_sprint: stats?.activeSprint,
        completion_projection: stats?.completionProjection,
        open_risks: risks?.unavailable ?? riskList.slice(0, 10).map((r: any) => compact({ code: r.code, title: r.title, score: r.score, severity: r.severity, status: r.status })),
        overview: overview?.unavailable ? undefined : overview,
        ai_insight: aiInsight?.unavailable ? undefined : aiInsight,
      }),
    );
  });

  defineTool(server, ctx, 'plusdesk_team_workload', {
    title: 'Team workload',
    description: 'Who is carrying what in a project: open tickets, overdue, blocked and estimated hours per person, plus logged hours where permitted.',
    kind: 'read',
    input: { project: P.project },
  }, async (a) => {
    const p = await resolve.project(a.project);
    const [tickets, heatmap, members] = await Promise.all([
      allTickets(api, { projectId: p.id }),
      optional(() => api.get('/dashboards/workload', { projectId: p.id })),
      api.get(`/projects/${p.id}/members`),
    ]);
    const { workload_by_assignee } = summarizeTickets(tickets);
    for (const m of listOf(members)) workload_by_assignee[m.display_name] ??= { open: 0, overdue: 0, blocked: 0, estimated_hours: 0 };
    return ok(`Workload for ${p.key ?? p.name}`, compact({ by_person: workload_by_assignee, heatmap: heatmap?.unavailable ? undefined : heatmap }));
  });

  defineTool(server, ctx, 'plusdesk_sprint_report', {
    title: 'Sprint report',
    description: 'Sprint progress: burndown, tickets by status, plus board velocity. Defaults to the active sprint of the project board.',
    kind: 'read',
    input: { project: P.project, sprint: z.string().optional().describe('Sprint name or id (default "active")') },
  }, async (a) => {
    const p = await resolve.project(a.project);
    const board = await resolve.board(p.id);
    const sprintId = await resolve.sprintId(a.sprint ?? 'active', board.id);
    const [burndown, tickets, velocity, intel] = await Promise.all([
      optional(() => api.get(`/sprints/${sprintId}/burndown`)),
      allTickets(api, { sprintId }),
      optional(() => api.get(`/boards/${board.id}/velocity`)),
      optional(() => api.get(`/projects/${p.id}/sprint/intelligence`)),
    ]);
    const s = summarizeTickets(tickets);
    return ok(`Sprint: ${s.totals.tickets} tickets, ${s.totals.tickets - s.totals.open} done, ${s.totals.blocked} blocked`, compact({
      totals: s.totals, by_status: countBy(tickets, (t) => t.status), workload_by_assignee: s.workload_by_assignee,
      blocked: s.blocked, burndown, velocity, intelligence: intel?.unavailable ? undefined : intel,
    }));
  });

  defineTool(server, ctx, 'plusdesk_flow_analytics', {
    title: 'Flow analytics',
    description: 'Delivery flow metrics for a project over a date range: cycle time, lead time, cumulative flow, or blocked-time analysis.',
    kind: 'read',
    input: {
      project: P.project,
      metric: z.enum(['cycle-time', 'lead-time', 'cumulative-flow', 'blocked', 'aging']),
      from: P.date.optional().describe('Default: 30 days ago'),
      to: P.date.optional().describe('Default: today'),
      group_by: z.enum(['day', 'week', 'month']).optional(),
    },
  }, async (a) => {
    const projectId = await resolve.projectId(a.project);
    const now = new Date();
    const res = await api.get(`/projects/${projectId}/analytics/${a.metric}`, {
      startDate: a.from ?? isoDay(new Date(now.getTime() - 30 * DAY)),
      endDate: a.to ?? isoDay(now),
      groupBy: a.group_by,
    });
    return ok(`${a.metric} for ${a.project}`, res);
  });

  defineTool(server, ctx, 'plusdesk_time_report', {
    title: 'Time report',
    description:
      'Hours logged in a date range. Tries the project-wide rollup (needs manager permissions); otherwise reports your own timesheet grouped by ticket.',
    kind: 'read',
    input: { project: P.project.optional(), from: P.date.optional(), to: P.date.optional() },
  }, async (a) => {
    const projectId = a.project ? await resolve.projectId(a.project) : undefined;
    if (projectId) {
      const summary = await optional(() => api.get('/worklogs/summary', { projectId, from: a.from, to: a.to }));
      if (!summary?.unavailable) return ok(`Logged time for ${a.project}`, summary);
    }
    const sheet = await api.get('/worklogs', { from: a.from, to: a.to });
    const entries = listOf(sheet.entries ?? sheet);
    const byTicket: Record<string, number> = {};
    for (const e of entries) {
      const k = e.ticket_number ?? e.ticket_title ?? e.ticket_id;
      byTicket[k] = (byTicket[k] ?? 0) + (Number(e.hours_spent) || 0);
    }
    return ok(`Your time ${sheet.from} → ${sheet.to}: ${sheet.total_hours ?? 0}h${projectId ? ' (project rollup not permitted for your role)' : ''}`, {
      by_ticket: byTicket,
      by_day: entries.reduce<Record<string, number>>((acc, e) => ((acc[e.work_date] = (acc[e.work_date] ?? 0) + (Number(e.hours_spent) || 0)), acc), {}),
    });
  });

  defineTool(server, ctx, 'plusdesk_activity', {
    title: 'Recent activity',
    description: 'Recent activity feed across your projects, optionally for one ticket.',
    kind: 'read',
    input: { ticket: P.ticket.optional(), limit: P.limit },
  }, async (a) => {
    const resourceId = a.ticket ? await resolve.ticketId(a.ticket) : undefined;
    const res = await api.get('/activity', { resourceType: resourceId ? 'ticket' : undefined, resourceId, limit: a.limit ?? 25 });
    return ok('Recent activity', listOf(res).map((e) => compact({
      at: e.created_at, actor: e.actor_name ?? e.actor_id ?? 'system', action: e.action, item: e.resource_label ?? e.resource_type,
      details: e.details && Object.keys(e.details).length ? e.details : undefined,
    })));
  });
}
