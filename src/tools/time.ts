import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compact, listOf, ok, worklog } from '../format.js';
import { ResolveError } from '../resolvers.js';
import { defineTool, P, requireConfirm, type Ctx } from './registry.js';

const today = () => new Date().toISOString().slice(0, 10);

export function registerTimeTools(server: McpServer, ctx: Ctx) {
  const { api, resolve } = ctx;

  defineTool(server, ctx, 'plusdesk_log_time', {
    title: 'Log time',
    description: 'Log hours you worked on a ticket. A short description of the work is required.',
    kind: 'write',
    input: {
      ticket: P.ticket,
      hours: z.number().positive().max(24).describe('Hours spent, e.g. 1.5'),
      description: z.string().min(1).describe('What was done'),
      date: P.date.optional().describe('Work date (default today)'),
    },
  }, async (a) => {
    const id = await resolve.ticketId(a.ticket);
    const w = await api.post(`/tickets/${id}/worklogs`, { hoursSpent: a.hours, workDate: a.date ?? today(), description: a.description });
    return ok(`Logged ${a.hours}h on ${a.ticket} for ${w.work_date}`, worklog(w));
  });

  defineTool(server, ctx, 'plusdesk_list_worklogs', {
    title: 'List worklogs / timesheet',
    description:
      'With `ticket`: all time entries on that ticket. Without: a timesheet of entries for a user (default you) in a date range (default last 7 days). ' +
      "Viewing other people's timesheets needs the worklog:read_team permission.",
    kind: 'read',
    input: {
      ticket: P.ticket.optional(),
      user: P.user.optional(),
      from: P.date.optional(),
      to: P.date.optional(),
    },
  }, async (a) => {
    if (a.ticket) {
      const id = await resolve.ticketId(a.ticket);
      const logs = listOf(await api.get(`/tickets/${id}/worklogs`)).map(worklog);
      const total = logs.reduce((s, w) => s + (w.hours ?? 0), 0);
      return ok(`${logs.length} entries, ${total}h total on ${a.ticket}`, logs);
    }
    const userId = a.user ? await resolve.userId(a.user) : undefined;
    const res = await api.get('/worklogs', { userId, from: a.from, to: a.to });
    const entries = listOf(res.entries ?? res).map(worklog);
    return ok(`Timesheet ${res.from ?? a.from} → ${res.to ?? a.to}: ${res.total_hours ?? entries.reduce((s, w) => s + (w.hours ?? 0), 0)}h`, entries);
  });

  defineTool(server, ctx, 'plusdesk_update_worklog', {
    title: 'Update worklog',
    description: 'Edit one of your own time entries (hours, date, description). Get the id from plusdesk_list_worklogs.',
    kind: 'write',
    idempotent: true,
    input: {
      worklog_id: z.string().uuid(),
      hours: z.number().positive().max(24).optional(),
      date: P.date.optional(),
      description: z.string().min(1).optional(),
    },
  }, async (a) => {
    const body = compact({ hoursSpent: a.hours, workDate: a.date, description: a.description });
    if (!Object.keys(body).length) throw new ResolveError('Nothing to update');
    const w = await api.patch(`/tickets/worklogs/${a.worklog_id}`, body);
    return ok('Worklog updated', worklog(w));
  });

  defineTool(server, ctx, 'plusdesk_delete_worklog', {
    title: 'Delete worklog',
    description: 'Delete one of your own time entries.',
    kind: 'destructive',
    input: { worklog_id: z.string().uuid(), confirm: P.confirm },
  }, async (a) => {
    requireConfirm(a.confirm, 'delete a worklog');
    await api.delete(`/tickets/worklogs/${a.worklog_id}`);
    return ok('Worklog deleted');
  });
}
