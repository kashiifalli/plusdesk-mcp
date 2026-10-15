import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  baseUrl: string;
  tenantSlug: string;
  apiToken?: string;
  email?: string;
  password?: string;
  readOnly: boolean;
  allowDirectStatus: boolean;
  timeoutMs: number;
}

/** Load KEY=VALUE pairs from a .env file without overriding real environment variables. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : /^(1|true|yes)$/i.test(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv(env.PLUSDESK_ENV_FILE ?? path.resolve(process.cwd(), '.env'));

  const missing: string[] = [];
  const baseUrl = env.PLUSDESK_BASE_URL?.replace(/\/+$/, '');
  const tenantSlug = env.PLUSDESK_TENANT_SLUG;
  if (!baseUrl) missing.push('PLUSDESK_BASE_URL');
  if (!tenantSlug) missing.push('PLUSDESK_TENANT_SLUG');
  const apiToken = env.PLUSDESK_API_TOKEN || undefined;
  const email = env.PLUSDESK_EMAIL || undefined;
  const password = env.PLUSDESK_PASSWORD || undefined;
  if (!apiToken && !(email && password)) missing.push('PLUSDESK_API_TOKEN or PLUSDESK_EMAIL + PLUSDESK_PASSWORD');
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}. See .env.example.`);

  return {
    baseUrl: baseUrl!,
    tenantSlug: tenantSlug!,
    apiToken,
    email,
    password,
    readOnly: bool(env.PLUSDESK_READ_ONLY, false),
    allowDirectStatus: bool(env.PLUSDESK_ALLOW_DIRECT_STATUS, false),
    timeoutMs: Number(env.PLUSDESK_TIMEOUT_MS) || 30_000,
  };
}
