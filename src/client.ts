import type { Config } from './config.js';

export class PlusDeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'PlusDeskError';
  }

  get forbidden() {
    return this.status === 403;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin HTTP client for the PulseDesk API.
 * Sends the tenant slug header on every call, logs in lazily, refreshes the
 * access token once on 401, and retries transient failures with backoff.
 */
export class PlusDeskClient {
  private accessToken?: string;
  private refreshToken?: string;
  private loginInFlight?: Promise<void>;

  constructor(private readonly cfg: Config) {
    this.accessToken = cfg.apiToken;
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body: body ?? {} });
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, { body: body ?? {} });
  }
  put<T = any>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body: body ?? {} });
  }
  delete<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    if (!this.accessToken) await this.login();
    let res = await this.send(method, path, opts);
    if (res.status === 401 && !this.cfg.apiToken) {
      await this.reauthenticate();
      res = await this.send(method, path, opts);
    }
    return this.parse<T>(res, path);
  }

  private async send(method: string, path: string, opts: RequestOptions, auth = true): Promise<Response> {
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-tenant-slug': this.cfg.tenantSlug,
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (err) {
        if (attempt < 2) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new PlusDeskError(`Network error calling ${method} ${path}: ${(err as Error).message}`, 0, path);
      }
      if (RETRYABLE.has(res.status) && attempt < 2) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      return res;
    }
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const raw = body?.message ?? body?.error ?? (typeof body === 'string' ? body : res.statusText);
      const message = Array.isArray(raw) ? raw.join('; ') : String(raw);
      const hint =
        res.status === 403
          ? ' (your PlusDesk role does not allow this action)'
          : message === 'Tenant not found'
            ? ' (check PLUSDESK_TENANT_SLUG)'
            : '';
      throw new PlusDeskError(`${res.status}: ${message}${hint}`, res.status, path, body?.correlationId);
    }
    return body as T;
  }

  private async login(): Promise<void> {
    if (this.cfg.apiToken) return;
    this.loginInFlight ??= (async () => {
      const res = await this.send('POST', '/auth/login', { body: { email: this.cfg.email, password: this.cfg.password } }, false);
      const data = await this.parse<any>(res, '/auth/login');
      if (!data?.accessToken) throw new PlusDeskError('Login did not return an access token (MFA may be required)', res.status, '/auth/login');
      this.accessToken = data.accessToken;
      this.refreshToken = data.refreshToken;
    })().finally(() => (this.loginInFlight = undefined));
    return this.loginInFlight;
  }

  private async reauthenticate(): Promise<void> {
    if (this.refreshToken) {
      const res = await this.send('POST', '/auth/refresh', { body: { refreshToken: this.refreshToken } }, false);
      if (res.ok) {
        const data: any = await res.json().catch(() => undefined);
        if (data?.accessToken) {
          this.accessToken = data.accessToken;
          if (data.refreshToken) this.refreshToken = data.refreshToken;
          return;
        }
      }
    }
    this.accessToken = undefined;
    await this.login();
  }
}
