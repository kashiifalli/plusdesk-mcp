import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PlusDeskError } from './client.js';
import { ResolveError } from './resolvers.js';

const clip = (s: unknown, n: number) => {
  if (typeof s !== 'string') return s ?? undefined;
  return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s;
};

/** Drop null/undefined/empty-array fields so payloads stay small for the model. */
export function compact<T extends Record<string, any>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)),
  ) as Partial<T>;
}

/** Ticket fields useful to an assistant; `full` adds description and planning detail. */
export function ticket(t: any, full = false) {
  if (!t) return t;
  const base = {
    id: t.id,
    key: t.ticket_number,
    title: t.title,
    type: t.type,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee_name ?? t.assignee_email ?? t.assignee_id,
    due_date: t.due_date,
    blocked: t.blocked || undefined,
    blocked_reason: t.blocked_reason,
    parent_id: t.parent_id,
    labels: t.labels,
  };
  if (!full) return compact(base);
  return compact({
    ...base,
    description: clip(t.description_text ?? t.description, 4000),
    severity: t.severity,
    environment: t.environment,
    story_points: t.story_points,
    estimated_hours: t.estimated_hours,
    start_at: t.start_at,
    end_at: t.end_at,
    steps_to_reproduce: clip(t.steps_to_reproduce, 2000),
    acceptance_criteria: clip(t.acceptance_criteria, 2000),
    epic_link_id: t.epic_link_id,
    project_id: t.project_id,
    board_id: t.board_id,
    board_column_id: t.board_column_id,
    sprint_id: t.sprint_id,
    fix_version: t.fix_version,
    reporter: t.reporter_name ?? t.reporter_id,
    custom_fields: t.custom_fields && Object.keys(t.custom_fields).length ? t.custom_fields : undefined,
    sla_status: t.sla_status,
    comment_count: t.commentCount,
    created_at: t.created_at,
    updated_at: t.updated_at,
    completed_at: t.completed_at,
  });
}

export function subitem(s: any) {
  return compact({
    id: s.id,
    name: s.name,
    status: s.status,
    assignee: s.assignee_name ?? s.assignee_id,
    description: s.description,
    start_at: s.start_at,
    end_at: s.end_at,
    position: s.position,
  });
}

export function worklog(w: any) {
  return compact({
    id: w.id,
    ticket_id: w.ticket_id,
    ticket: w.ticket_number,
    user: w.user_name,
    work_date: w.work_date,
    hours: w.hours_spent === null || w.hours_spent === undefined ? undefined : Number(w.hours_spent),
    description: w.description,
  });
}

export const listOf = (res: any): any[] => (Array.isArray(res) ? res : (res?.data ?? res?.items ?? []));

export function ok(summary: string, data?: unknown): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text }] };
}

export function fail(err: unknown): CallToolResult {
  let msg: string;
  if (err instanceof PlusDeskError) {
    msg = `PlusDesk API error ${err.message}${err.correlationId ? ` [correlationId ${err.correlationId}]` : ''}`;
  } else if (err instanceof ResolveError) {
    msg = err.message;
  } else {
    msg = `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  }
  return { content: [{ type: 'text', text: msg }], isError: true };
}
