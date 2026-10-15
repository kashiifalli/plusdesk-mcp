import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compact, listOf, ok, subitem, ticket } from '../format.js';
import { ResolveError } from '../resolvers.js';
import { defineTool, P, requireConfirm, type Ctx } from './registry.js';

const TYPES = ['bug', 'story', 'task', 'sub_task', 'epic', 'incident', 'change_request', 'support_request', 'feature_request'] as const;
const FIB = [1, 2, 3, 5, 8, 13, 21];
const isoDateTime = z.string().describe('ISO date or datetime, e.g. 2026-10-20 or 2026-10-20T09:00:00Z');

/** Fields shared by create and update. */
const detailFields = {
  description: z.string().optional().describe('Description (Markdown/plain text). Required for bug, story, epic.'),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']).optional(),
  environment: z.enum(['dev', 'staging', 'uat', 'production']).optional(),
  steps_to_reproduce: z.string().optional().describe('Required for bugs'),
  acceptance_criteria: z.string().optional(),
  story_points: z.number().optional().describe('Fibonacci only: 1,2,3,5,8,13,21'),
  estimated_hours: z.number().positive().optional(),
  due_date: P.date.optional(),
  start_at: isoDateTime.optional(),
  end_at: isoDateTime.optional(),
  labels: z.array(z.string()).optional(),
  epic: P.ticket.optional().describe('Epic ticket key/id to link this ticket under'),
  sprint: z.string().optional().describe('Sprint id or name ("active" for the current sprint)'),
  fix_version: z.string().optional(),
};

function checkStoryPoints(sp?: number) {
  if (sp !== undefined && !FIB.includes(sp)) throw new ResolveError(`story_points must be one of ${FIB.join(', ')}`);
}

/** Notes where the server changed values we sent (PlusDesk auto-triage can adjust priority/labels). */
function serverAdjustments(sent: Record<string, unknown>, saved: any): string {
  const notes: string[] = [];
  if (sent.priority && saved.priority !== sent.priority) notes.push(`priority set to ${saved.priority} (requested ${sent.priority})`);
  const extra = (saved.labels ?? []).filter((l: string) => !((sent.labels as string[]) ?? []).includes(l));
  if (extra.length) notes.push(`labels added by server: ${extra.join(', ')}`);
  return notes.length ? `\nNote: ${notes.join('; ')}.` : '';
}

export function registerTaskTools(server: McpServer, ctx: Ctx) {
  const { api, resolve } = ctx;

  async function detailBody(a: any, projectId?: string, boardId?: string) {
    checkStoryPoints(a.story_points);
    return compact({
      description: a.description,
      priority: a.priority,
      severity: a.severity,
      environment: a.environment,
      stepsToReproduce: a.steps_to_reproduce,
      acceptanceCriteria: a.acceptance_criteria,
      storyPoints: a.story_points,
      estimatedHours: a.estimated_hours,
      dueDate: a.due_date,
      startAt: a.start_at,
      endAt: a.end_at,
      labels: a.labels,
      epicLinkId: a.epic ? await resolve.ticketId(a.epic) : undefined,
      sprintId: a.sprint ? await resolve.sprintId(a.sprint, boardId) : undefined,
      fixVersion: a.fix_version,
      assigneeId: a.assignee ? await resolve.userId(a.assignee, projectId) : undefined,
    });
  }

  defineTool(server, ctx, 'plusdesk_create_task', {
    title: 'Create task',
    description:
      'Create a ticket in a project (task, story, bug, epic, …). It goes on the project board; pass `column` to place it in a specific column or `to_backlog` to keep it in the backlog. ' +
      'For sub-tasks or checklist items under an existing ticket use plusdesk_create_subtask.',
    kind: 'write',
    input: {
      project: P.project,
      title: z.string().min(1),
      type: z.enum(TYPES).default('task'),
      assignee: P.user.optional(),
      board: z.string().optional().describe('Board name/id (only needed if the project has several boards)'),
      column: z.string().optional().describe('Board column name, e.g. "To Do", "In Progress"'),
      to_backlog: z.boolean().optional(),
      ...detailFields,
    },
  }, async (a) => {
    if (a.type === 'sub_task') throw new ResolveError('Use plusdesk_create_subtask to create sub-tasks (they need a parent ticket).');
    if (['bug', 'story', 'epic'].includes(a.type) && !a.description) throw new ResolveError(`description is required for type ${a.type}`);
    if (a.type === 'bug' && !a.steps_to_reproduce) throw new ResolveError('steps_to_reproduce is required for bugs');

    const project = await resolve.project(a.project);
    const config = await resolve.cached(`config:${project.id}`, () => api.get(`/projects/${project.id}/config`));
    if (config.ticketTypes && !config.ticketTypes.includes(a.type)) {
      throw new ResolveError(`Project ${project.key ?? project.name} does not allow type "${a.type}". Allowed: ${config.ticketTypes.join(', ')}`);
    }
    const board = await resolve.board(project.id, a.board);
    const column = a.column ? await resolve.column(board.id, a.column) : undefined;
    const body = {
      title: a.title,
      type: a.type,
      priority: a.priority ?? 'medium',
      ...(await detailBody(a, project.id, board.id)),
      boardId: board.id,
      boardColumnId: column?.id,
      toBacklog: a.to_backlog,
    };
    const t = await api.post('/tickets', body);
    return ok(`Created ${t.ticket_number} "${t.title}" in ${project.key ?? project.name} [${t.status}]${serverAdjustments(body, t)}`, ticket(t, true));
  });

  defineTool(server, ctx, 'plusdesk_update_task', {
    title: 'Update task',
    description:
      'Fill in or change ticket details: title, description, priority, dates, estimates, story points, labels, epic, sprint, custom fields. ' +
      'Only the fields you pass are changed. Pass null for due_date/assignee to clear. Use plusdesk_move_task to change status.',
    kind: 'write',
    idempotent: true,
    input: {
      ticket: P.ticket,
      title: z.string().min(1).optional(),
      type: z.enum(TYPES).optional(),
      assignee: P.user.nullable().optional().describe('User, or null to unassign'),
      custom_fields: z.record(z.string(), z.unknown()).optional(),
      ...detailFields,
      due_date: P.date.nullable().optional(),
    },
  }, async (a) => {
    const id = await resolve.ticketId(a.ticket);
    const current = await api.get(`/tickets/${id}`);
    const body: Record<string, unknown> = {
      ...(await detailBody({ ...a, assignee: a.assignee ?? undefined }, current.project_id, current.board_id)),
      ...compact({ title: a.title, type: a.type, customFields: a.custom_fields }),
    };
    if (a.assignee === null) body.assigneeId = null;
    if (a.due_date === null) body.dueDate = null;
    if (!Object.keys(body).length) throw new ResolveError('Nothing to update: pass at least one field.');
    const t = await api.patch(`/tickets/${id}`, body);
    return ok(`Updated ${t.ticket_number}: ${Object.keys(body).join(', ')}${serverAdjustments(body, t)}`, ticket(t, true));
  });

  defineTool(server, ctx, 'plusdesk_create_subtask', {
    title: 'Create subtask',
    description:
      'Add a subtask under a parent ticket. mode "ticket" (default) creates a full sub_task ticket with its own status, assignee and time tracking. ' +
      'mode "checklist" adds a lightweight checklist item (name, assignee, dates within the parent window, pending/done).',
    kind: 'write',
    input: {
      parent: P.ticket,
      title: z.string().min(1),
      mode: z.enum(['ticket', 'checklist']).default('ticket'),
      assignee: P.user.optional(),
      description: z.string().optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('ticket mode only'),
      estimated_hours: z.number().positive().optional().describe('ticket mode only'),
      due_date: P.date.optional().describe('ticket mode only'),
      start_at: isoDateTime.optional(),
      end_at: isoDateTime.optional().describe('Deadline; in checklist mode must fall within the parent window'),
    },
  }, async (a) => {
    const parentId = await resolve.ticketId(a.parent);
    const parent = await api.get(`/tickets/${parentId}`);
    const assigneeId = a.assignee ? await resolve.userId(a.assignee, parent.project_id) : undefined;

    if (a.mode === 'checklist') {
      const s = await api.post(`/tickets/${parentId}/subitems`, compact({
        name: a.title, description: a.description, assigneeId, startAt: a.start_at, endAt: a.end_at,
      }));
      return ok(`Added checklist item "${s.name}" to ${parent.ticket_number}`, subitem(s));
    }
    const body = compact({
      title: a.title,
      type: 'sub_task',
      priority: a.priority ?? parent.priority ?? 'medium',
      parentId,
      boardId: parent.board_id,
      description: a.description,
      assigneeId,
      estimatedHours: a.estimated_hours,
      dueDate: a.due_date,
      startAt: a.start_at,
      endAt: a.end_at,
    });
    const t = await api.post('/tickets', body);
    return ok(`Created sub-task ${t.ticket_number} "${t.title}" under ${parent.ticket_number}${serverAdjustments(body, t)}`, ticket(t, true));
  });

  defineTool(server, ctx, 'plusdesk_update_checklist_item', {
    title: 'Update checklist item',
    description: 'Update a checklist subitem on a ticket: mark done/pending, rename, reassign, change dates, reorder.',
    kind: 'write',
    idempotent: true,
    input: {
      ticket: P.ticket,
      item: z.string().describe('Checklist item id or its name'),
      status: z.enum(['pending', 'done']).optional(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      assignee: P.user.nullable().optional(),
      start_at: isoDateTime.nullable().optional(),
      end_at: isoDateTime.nullable().optional(),
      position: z.number().int().min(0).optional(),
    },
  }, async (a) => {
    const id = await resolve.ticketId(a.ticket);
    const itemId = await findSubitem(id, a.item);
    const body: Record<string, unknown> = compact({ status: a.status, name: a.name, position: a.position });
    for (const k of ['description', 'start_at', 'end_at'] as const) {
      if (a[k] !== undefined) body[k === 'start_at' ? 'startAt' : k === 'end_at' ? 'endAt' : k] = a[k];
    }
    if (a.assignee !== undefined) body.assigneeId = a.assignee === null ? null : await resolve.userId(a.assignee);
    const s = await api.patch(`/tickets/${id}/subitems/${itemId}`, body);
    return ok(`Updated checklist item "${s.name}" [${s.status}]`, subitem(s));
  });

  defineTool(server, ctx, 'plusdesk_delete_checklist_item', {
    title: 'Delete checklist item',
    description: 'Delete a checklist subitem from a ticket.',
    kind: 'destructive',
    input: { ticket: P.ticket, item: z.string().describe('Checklist item id or name'), confirm: P.confirm },
  }, async (a) => {
    requireConfirm(a.confirm, 'delete a checklist item');
    const id = await resolve.ticketId(a.ticket);
    const itemId = await findSubitem(id, a.item);
    await api.delete(`/tickets/${id}/subitems/${itemId}`);
    return ok('Checklist item deleted');
  });

  async function findSubitem(ticketId: string, ref: string): Promise<string> {
    const items = listOf(await api.get(`/tickets/${ticketId}/subitems`));
    const hit = items.find((s) => s.id === ref) ?? items.filter((s) => s.name?.toLowerCase() === ref.toLowerCase())[0]
      ?? (() => {
        const partial = items.filter((s) => s.name?.toLowerCase().includes(ref.toLowerCase()));
        return partial.length === 1 ? partial[0] : undefined;
      })();
    if (!hit) throw new ResolveError(`No unique checklist item "${ref}". Items: ${items.map((s) => s.name).join('; ') || 'none'}`);
    return hit.id;
  }

  defineTool(server, ctx, 'plusdesk_assign_task', {
    title: 'Assign task',
    description: 'Assign one or more tickets to a user (or unassign with assignee null).',
    kind: 'write',
    idempotent: true,
    input: {
      tickets: z.array(P.ticket).min(1).max(100),
      assignee: P.user.nullable().describe('User to assign, or null to unassign'),
    },
  }, async (a) => {
    const ids = await Promise.all(a.tickets.map((t) => resolve.ticketId(t)));
    const first = ids.length === 1 ? await api.get(`/tickets/${ids[0]}`) : undefined;
    const assigneeId = a.assignee === null ? null : await resolve.userId(a.assignee, first?.project_id);
    if (ids.length === 1) {
      const t = await api.patch(`/tickets/${ids[0]}`, { assigneeId });
      return ok(`${t.ticket_number} ${assigneeId ? `assigned to ${t.assignee_name ?? a.assignee}` : 'unassigned'}`, ticket(t));
    }
    const res = await api.post('/tickets/bulk-operate', { action: 'assign', ticketIds: ids, payload: { assigneeId } });
    return ok(`Assigned ${res.success?.length ?? 0} tickets, ${res.failed?.length ?? 0} failed`, res);
  });

  defineTool(server, ctx, 'plusdesk_add_comment', {
    title: 'Add comment',
    description: 'Add a comment to a ticket. internal=true hides it from client users.',
    kind: 'write',
    input: { ticket: P.ticket, body: z.string().min(1), internal: z.boolean().optional() },
  }, async (a) => {
    const id = await resolve.ticketId(a.ticket);
    const c = await api.post(`/tickets/${id}/comments`, compact({ body: a.body, isInternal: a.internal }));
    return ok('Comment added', compact({ id: c.id, body: c.body, internal: c.is_internal }));
  });

  defineTool(server, ctx, 'plusdesk_link_tasks', {
    title: 'Link tasks',
    description: 'Link two tickets (blocks, is-blocked-by, duplicates, relates-to, depends_on, depended-by).',
    kind: 'write',
    input: {
      ticket: P.ticket,
      target: P.ticket,
      link_type: z.enum(['blocks', 'is-blocked-by', 'duplicates', 'relates-to', 'depends_on', 'depended-by']),
    },
  }, async (a) => {
    const [id, targetId] = await Promise.all([resolve.ticketId(a.ticket), resolve.ticketId(a.target)]);
    const res = await api.post(`/tickets/${id}/links`, { targetId, linkType: a.link_type });
    return ok(`Linked ${a.ticket} ${a.link_type} ${a.target}`, res);
  });

  defineTool(server, ctx, 'plusdesk_set_blocked', {
    title: 'Block / unblock task',
    description: 'Mark a ticket as blocked (with reason and optional blocking ticket) or clear the blocked flag.',
    kind: 'write',
    idempotent: true,
    input: {
      ticket: P.ticket,
      blocked: z.boolean(),
      reason: z.string().optional().describe('Why it is blocked (required when blocking)'),
      blocker: P.ticket.optional().describe('Ticket that blocks this one'),
    },
  }, async (a) => {
    const id = await resolve.ticketId(a.ticket);
    if (!a.blocked) {
      const t = await api.patch(`/tickets/${id}/unblock`);
      return ok(`${a.ticket} unblocked`, ticket(t));
    }
    if (!a.reason) throw new ResolveError('reason is required when blocking a ticket');
    const t = await api.patch(`/tickets/${id}/block`, compact({
      reason: a.reason, blockerTicketId: a.blocker ? await resolve.ticketId(a.blocker) : undefined,
    }));
    return ok(`${a.ticket} marked blocked: ${a.reason}`, ticket(t));
  });

  defineTool(server, ctx, 'plusdesk_delete_task', {
    title: 'Delete task',
    description: 'Soft-delete a ticket. Requires permission (developers usually cannot) and confirm=true.',
    kind: 'destructive',
    input: { ticket: P.ticket, confirm: P.confirm },
  }, async (a) => {
    requireConfirm(a.confirm, 'delete a ticket');
    const id = await resolve.ticketId(a.ticket);
    await api.delete(`/tickets/${id}`);
    return ok(`${a.ticket} deleted`);
  });
}
