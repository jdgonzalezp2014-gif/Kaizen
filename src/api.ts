/** Thin typed client. Every call goes to a Pages Function; none touch a credential. */

export interface Account {
  id: number; name: string;
  hostawayAccountId: string | null;
  hasHostawayKey: boolean;
  targetNetPerUnit: number; occFloorPct: number; stayNights: number;
  allowedEmails: string[];
}
export interface Connection { ok: boolean; message: string; units?: number }
export interface SettingsResponse { ok: boolean; user: string; account: Account; connection: Connection }

export interface ImportProblem { row: number; problem: string }
export interface ImportResult {
  ok: boolean; dryRun: boolean; kind: string;
  total?: number; ready?: number; written?: number; skipped?: number;
  problems?: ImportProblem[]; preview?: unknown[]; error?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  // A failed call returns its reason rather than throwing a generic
  // Error, because every one of these has a message worth showing.
  if (!res.ok && !(body as { error?: unknown }).error) {
    throw new Error(`HTTP ${res.status}`);
  }
  return body as T;
}

export const getSettings = () => call<SettingsResponse>('/api/settings');

export const saveSettings = (body: Record<string, unknown>) =>
  call<{ ok: boolean; account?: Account; error?: string }>('/api/settings', {
    method: 'POST', body: JSON.stringify(body)
  });

export const importCsv = (kind: 'expenses' | 'claims', csv: string, opts: { commit?: boolean; dayFirst?: boolean } = {}) =>
  call<ImportResult>('/api/import', {
    method: 'POST', body: JSON.stringify({ kind, csv, ...opts })
  });

export const syncUnits = () =>
  call<{ ok: boolean; fetched?: number; active?: number; error?: string }>('/api/sync-units', { method: 'POST' });
