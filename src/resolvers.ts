import type { PlusDeskClient } from './client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const CACHE_TTL_MS = 5 * 60_000;

export const isUuid = (s: string) => UUID_RE.test(s);
export const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** Pick one item whose label matches `ref`: exact match first, then a unique substring match. */
export function pickOne<T>(items: T[], ref: string, labels: (t: T) => (string | null | undefined)[], kind: string): T {
  const want = norm(ref);
  const exact = items.filter((i) => labels(i).some((l) => l && norm(l) === want));
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : items.filter((i) => labels(i).some((l) => l && norm(l).includes(want)));
  if (partial.length === 1) return partial[0];
  const show = (list: T[]) => list.slice(0, 10).map((i) => labels(i).filter(Boolean).join(' / ')).join('; ');
  if (!partial.length) throw new ResolveError(`No ${kind} matches "${ref}". Available: ${show(items) || 'none'}`);
  throw new ResolveError(`"${ref}" matches several ${kind}s: ${show(partial)}. Be more specific.`);
}

export class Resolver {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly api: PlusDeskClient) {}

  async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  invalidate(prefix: string) {
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  me() {
    return this.cached('me', () => this.api.get('/auth/me'));
  }

  async projects(): Promise<any[]> {
    return this.cached('projects', async () => {
      const all: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await this.api.get('/projects', { limit: 100, page });
        const rows: any[] = Array.isArray(res) ? res : (res.data ?? []);
        all.push(...rows);
        if (Array.isArray(res) || rows.length < 100 || page >= (res.totalPages ?? page)) break;
      }
      return all;
    });
  }

  /** Accepts a project UUID, key (e.g. IDAT12) or name. */
  async project(ref: string): Promise<any> {
    const list = await this.projects();
    if (isUuid(ref)) return list.find((p) => p.id === ref) ?? { id: ref };
    return pickOne(list, ref, (p) => [p.key, p.name], 'project');
  }

  async projectId(ref: string): Promise<string> {
    return isUuid(ref) ? ref : (await this.project(ref)).id;
  }

  /** Accepts a user UUID, "me", an email or a display name. */
  async userId(ref: string, projectId?: string): Promise<string> {
    if (isUuid(ref)) return ref;
    if (norm(ref) === 'me') return (await this.me()).id;
    const users: any[] = await this.cached(`users:${projectId ?? ''}:${norm(ref)}`, () =>
      this.api.get('/users', { search: ref.includes('@') ? ref.split('@')[0] : ref, projectId }),
    );
    return pickOne(users, ref, (u) => [u.email, u.displayName], 'user').id;
  }

  /** Accepts a ticket UUID or a ticket key such as TICK-13523. */
  async ticketId(ref: string): Promise<string> {
    const r = ref.trim();
    if (isUuid(r)) return r;
    if (!TICKET_KEY_RE.test(r)) throw new ResolveError(`"${ref}" is not a ticket key (e.g. TICK-123) or id`);
    return this.cached(`ticket:${r.toUpperCase()}`, async () => {
      const hits: any[] = await this.api.get('/search', { q: r, limit: 10 });
      const hit = hits.find((h) => h.type === 'ticket' && String(h.title).toUpperCase().startsWith(`${r.toUpperCase()}:`));
      if (!hit) throw new ResolveError(`Ticket ${r} not found (or not visible to you)`);
      return hit.id as string;
    });
  }

  async boards(projectId: string): Promise<any[]> {
    return this.cached(`boards:${projectId}`, () => this.api.get(`/projects/${projectId}/boards`));
  }

  /** Board for a project: by id/name, or the only board when there is just one. */
  async board(projectId: string, ref?: string): Promise<any> {
    const boards = await this.boards(projectId);
    if (ref) return isUuid(ref) ? { id: ref } : pickOne(boards, ref, (b) => [b.name], 'board');
    if (boards.length === 1) return boards[0];
    if (!boards.length) throw new ResolveError('This project has no boards');
    throw new ResolveError(`Project has several boards, specify one: ${boards.map((b) => b.name).join('; ')}`);
  }

  /** Full board with columns (and the tickets in each column). Not cached: positions change often. */
  boardDetail(boardId: string): Promise<any> {
    return this.api.get(`/boards/${boardId}`);
  }

  async column(boardId: string, ref: string): Promise<any> {
    const board = await this.boardDetail(boardId);
    const cols: any[] = board.columns ?? [];
    return isUuid(ref) ? (cols.find((c) => c.id === ref) ?? { id: ref, tickets: [] }) : pickOne(cols, ref, (c) => [c.name], 'column');
  }

  async sprintId(ref: string, boardId?: string): Promise<string> {
    if (isUuid(ref)) return ref;
    const res = boardId ? await this.api.get(`/boards/${boardId}/sprints`) : await this.api.get('/sprints');
    const list: any[] = Array.isArray(res) ? res : (res.data ?? []);
    if (norm(ref) === 'active') {
      const active = list.find((s) => s.status === 'active');
      if (!active) throw new ResolveError('No active sprint found');
      return active.id;
    }
    return pickOne(list, ref, (s) => [s.name], 'sprint').id;
  }
}
