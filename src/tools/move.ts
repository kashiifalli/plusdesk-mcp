import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listOf, ok, ticket } from '../format.js';
import { norm, ResolveError } from '../resolvers.js';
import { defineTool, P, requireConfirm, type Ctx } from './registry.js';

export function registerMoveTools(server: McpServer, ctx: Ctx) {
  const { api, resolve, cfg } = ctx;

  /** Run the workflow transition that leads to `target` (a status name/slug or transition name). */
  async function transitionTo(id: string, target: string, reasonComment?: string) {
    const transitions = listOf(await api.get(`/tickets/${id}/transitions/all`));
    const want = norm(target);
    const matches = transitions.filter((t) => norm(t.to_status_name ?? '') === want || norm(t.name ?? '') === want);
    const usable = matches.find((t) => t.allowed !== false);
    const options = () =>
      transitions.map((t) => `${t.to_status_name}${t.allowed === false ? ` (blocked: ${(t.reasons ?? []).join(', ') || 'not allowed'})` : ''}`).join('; ');

    if (!usable) {
      if (matches.length) {
        const why = matches.map((t) => (t.reasons ?? []).join(', ') || (t.requires_approval ? 'requires approval' : 'not allowed')).join('; ');
        throw new ResolveError(`Transition to "${target}" is not allowed right now: ${why}.`);
      }
      if (cfg.allowDirectStatus) return null;
      throw new ResolveError(`No workflow transition leads to "${target}" from the current status. Possible next statuses: ${options() || 'none'}`);
    }
    const statusOptions = listOf(await api.get(`/tickets/${id}/status-options`).catch(() => []));
    const slug = statusOptions.find((s) => s.id === usable.to_status_id)?.slug ?? norm(usable.to_status_name).replace(/ /g, '_');
    if (norm(usable.from_status_name ?? '') === 'done' && !reasonComment) {
      throw new ResolveError('Moving a ticket out of Done requires reason_comment.');
    }
    await api.patch(`/tickets/${id}/transition`, { transitionId: usable.id, targetStatus: slug, ...(reasonComment ? { reasonComment } : {}) });
    return usable;
  }

  defineTool(server, ctx, 'plusdesk_move_task', {
    title: 'Move task',
    description:
      'Move a ticket. Give exactly ONE destination:\n' +
      '- status: workflow status name (e.g. "In Progress", "In Review", "Done"); uses the allowed workflow transition\n' +
      '- column: board column name; moves the card on the board (the status follows the column)\n' +
      '- backlog: true sends the card back to the backlog lane\n' +
      '- sprint: sprint name/id ("active" for the current sprint)\n' +
      '- project: move the ticket into another project',
    kind: 'write',
    input: {
      ticket: P.ticket,
      status: z.string().optional(),
      column: z.string().optional(),
      position: z.number().int().min(0).optional().describe('Position within the column (default: bottom)'),
      backlog: z.literal(true).optional(),
      sprint: z.string().optional(),
      project: P.project.optional(),
      reason_comment: z.string().optional().describe('Required when moving a ticket out of Done'),
    },
  }, async (a) => {
    const chosen = (['status', 'column', 'backlog', 'sprint', 'project'] as const).filter((k) => a[k] !== undefined);
    if (chosen.length !== 1) throw new ResolveError('Give exactly one destination: status, column, backlog, sprint or project.');
    const id = await resolve.ticketId(a.ticket);
    const before = await api.get(`/tickets/${id}`);
    const label = before.ticket_number;

    switch (chosen[0]) {
      case 'status': {
        const used = await transitionTo(id, a.status!, a.reason_comment);
        if (!used) {
          await api.patch(`/tickets/${id}`, { status: norm(a.status!).replace(/ /g, '_') });
        }
        const after = await api.get(`/tickets/${id}`);
        const via = used ? `via transition "${used.name}"` : 'by direct status override (workflow bypassed)';
        return ok(`${label}: ${before.status} → ${after.status} ${via}`, ticket(after));
      }
      case 'column': {
        if (!before.board_id) throw new ResolveError(`${label} is not on a board`);
        const col = await resolve.column(before.board_id, a.column!);
        const position = a.position ?? (col.tickets?.filter((t: any) => t.id !== id).length ?? 0);
        if (!before.board_column_id) {
          await api.post(`/boards/${before.board_id}/promote`, { ticketId: id, columnId: col.id, position });
        } else {
          await api.patch(`/tickets/${id}/position`, { columnId: col.id, position });
        }
        const after = await api.get(`/tickets/${id}`);
        return ok(`${label} moved to column "${col.name}" (status ${before.status} → ${after.status})`, ticket(after));
      }
      case 'backlog': {
        if (!before.board_id) throw new ResolveError(`${label} is not on a board`);
        await api.post(`/boards/${before.board_id}/demote`, { ticketId: id });
        return ok(`${label} sent back to the backlog`);
      }
      case 'sprint': {
        const sprintId = await resolve.sprintId(a.sprint!, before.board_id ?? undefined);
        await api.post(`/sprints/${sprintId}/tickets`, { ticketIds: [id] });
        return ok(`${label} added to sprint ${a.sprint}`);
      }
      case 'project': {
        const projectId = await resolve.projectId(a.project!);
        const res = await api.post('/tickets/bulk-operate', { action: 'add_to_project', ticketIds: [id], payload: { projectId } });
        if (res.failed?.length) throw new ResolveError(`Move failed: ${res.failed.map((f: any) => f.reason).join('; ')}`);
        const after = await api.get(`/tickets/${id}`);
        return ok(`${label} moved to project ${a.project}`, ticket(after));
      }
    }
  });

  defineTool(server, ctx, 'plusdesk_list_next_statuses', {
    title: 'List next statuses',
    description: 'Show which statuses a ticket can move to next, and why any transitions are blocked.',
    kind: 'read',
    input: { ticket: P.ticket },
  }, async (a) => {
    const id = await resolve.ticketId(a.ticket);
    const transitions = listOf(await api.get(`/tickets/${id}/transitions/all`));
    return ok(`${transitions.length} transitions`, transitions.map((t) => ({
      transition: t.name, from: t.from_status_name, to: t.to_status_name, allowed: t.allowed !== false,
      requires_approval: t.requires_approval || undefined, reasons: t.reasons?.length ? t.reasons : undefined,
    })));
  });

  defineTool(server, ctx, 'plusdesk_bulk_update', {
    title: 'Bulk update tasks',
    description:
      'Apply one change to up to 100 tickets: set priority, add/remove labels, set status, move to a board column, or close. ' +
      'Bulk status changes bypass per-ticket workflow checks, so confirm=true is required.',
    kind: 'destructive',
    input: {
      tickets: z.array(P.ticket).min(1).max(100),
      action: z.enum(['priority', 'add_labels', 'remove_labels', 'status', 'move', 'close']),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      labels: z.array(z.string()).optional(),
      status: z.string().optional().describe('Status slug, e.g. in_review'),
      project: P.project.optional().describe('For action=move: project that owns the board'),
      column: z.string().optional().describe('For action=move: target column name'),
      confirm: P.confirm,
    },
  }, async (a) => {
    requireConfirm(a.confirm, `bulk-${a.action} ${a.tickets.length} tickets`);
    const ids = await Promise.all(a.tickets.map((t) => resolve.ticketId(t)));
    let payload: Record<string, unknown> = {};
    switch (a.action) {
      case 'priority':
        if (!a.priority) throw new ResolveError('priority is required');
        payload = { priority: a.priority };
        break;
      case 'add_labels':
      case 'remove_labels':
        if (!a.labels?.length) throw new ResolveError('labels are required');
        payload = { labels: a.labels };
        break;
      case 'status':
        if (!a.status) throw new ResolveError('status is required');
        payload = { status: norm(a.status).replace(/ /g, '_') };
        break;
      case 'move': {
        if (!a.project || !a.column) throw new ResolveError('project and column are required for move');
        const board = await resolve.board(await resolve.projectId(a.project));
        payload = { boardId: board.id, columnId: (await resolve.column(board.id, a.column)).id };
        break;
      }
    }
    const res = await api.post('/tickets/bulk-operate', { action: a.action, ticketIds: ids, payload });
    return ok(`${a.action}: ${res.success?.length ?? 0} succeeded, ${res.failed?.length ?? 0} failed`, res.failed?.length ? res.failed : undefined);
  });
}
