import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isUuid, pickOne, ResolveError } from '../src/resolvers.js';
import { summarizeTickets } from '../src/tools/insights.js';

describe('config', () => {
  const base = { PLUSDESK_BASE_URL: 'http://x/api/v1/', PLUSDESK_TENANT_SLUG: 't' };

  it('accepts an API token or email+password and trims the base URL', () => {
    expect(loadConfig({ ...base, PLUSDESK_API_TOKEN: 'tok' }).baseUrl).toBe('http://x/api/v1');
    expect(loadConfig({ ...base, PLUSDESK_EMAIL: 'a@b', PLUSDESK_PASSWORD: 'p' }).email).toBe('a@b');
  });

  it('reports every missing setting', () => {
    expect(() => loadConfig({})).toThrow(/PLUSDESK_BASE_URL.*PLUSDESK_TENANT_SLUG.*PLUSDESK_API_TOKEN/);
  });

  it('defaults to safe behaviour', () => {
    const c = loadConfig({ ...base, PLUSDESK_API_TOKEN: 'tok' });
    expect(c.readOnly).toBe(false);
    expect(c.allowDirectStatus).toBe(false);
  });
});

describe('pickOne', () => {
  const projects = [
    { key: 'IDAT12', name: 'Import Document AI Tower' },
    { key: 'VP1234', name: 'Vendor Portal' },
    { key: 'COB123', name: 'Customer On Boarding' },
  ];
  const labels = (p: any) => [p.key, p.name];

  it('matches key or name case-insensitively', () => {
    expect(pickOne(projects, 'idat12', labels, 'project').key).toBe('IDAT12');
    expect(pickOne(projects, 'vendor portal', labels, 'project').key).toBe('VP1234');
  });

  it('falls back to a unique partial match', () => {
    expect(pickOne(projects, 'AI Tower', labels, 'project').key).toBe('IDAT12');
  });

  it('rejects ambiguous and unknown references with the options listed', () => {
    expect(() => pickOne(projects, 'o', labels, 'project')).toThrow(/several projects/);
    expect(() => pickOne(projects, 'zzz', labels, 'project')).toThrow(ResolveError);
  });

  it('recognises UUIDs', () => {
    expect(isUuid('132592e4-c857-4843-ac1e-cc53947684df')).toBe(true);
    expect(isUuid('TICK-1')).toBe(false);
  });
});

describe('summarizeTickets', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const tickets = [
    { id: '1', status: 'in_progress', priority: 'high', type: 'task', assignee_id: 'u1', assignee_name: 'Ali', due_date: '2026-10-10', estimated_hours: '4', updated_at: '2026-10-14T00:00:00Z' },
    { id: '2', status: 'triage', priority: 'low', type: 'bug', blocked: true, due_date: '2026-10-18', updated_at: '2026-10-01T00:00:00Z' },
    { id: '3', status: 'done', priority: 'medium', type: 'task', assignee_id: 'u1', assignee_name: 'Ali', completed_at: '2026-10-13T00:00:00Z' },
  ];

  it('computes totals from open tickets only', () => {
    const s = summarizeTickets(tickets, now);
    expect(s.totals).toMatchObject({
      tickets: 3, open: 2, completed_last_7_days: 1, overdue: 1, due_next_7_days: 1, blocked: 1, unassigned: 1, stale_over_7_days: 1, open_estimated_hours: 4,
    });
    expect(s.workload_by_assignee.Ali).toEqual({ open: 1, overdue: 1, blocked: 0, estimated_hours: 4 });
    expect(s.workload_by_assignee.Unassigned.blocked).toBe(1);
    expect(s.open_by_status).toEqual({ in_progress: 1, triage: 1 });
  });
});
