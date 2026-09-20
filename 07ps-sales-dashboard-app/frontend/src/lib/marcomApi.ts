/**
 * Client for the MARCOM Data Upload admin API (backend/src/routes/marcomUpload.ts).
 * Kept out of api.ts on purpose: it needs upload progress (XHR) and blob downloads, and the shared
 * module is large. Error handling mirrors api.ts: a failure becomes a MarcomApiError carrying the
 * server's stable `code` so the UI can branch on it (e.g. STAGED_EXPIRED -> "please re-upload").
 */
import { API_BASE } from './api';

export type TableId = 'spend' | 'campaigns' | 'media' | 'social' | 'web' | 'trade' | 'events';

export interface Issue {
  severity: 'error' | 'warning';
  sheet: string;
  table: TableId | '';
  cell: string;
  code: string;
  message: string;
}
export interface FieldChange { field: string; old: string | null; new: string | null }
export interface TablePreview {
  id: TableId; label: string; rowsFound: number; insert: number; update: number; unchanged: number;
  invalid: number; skippedEmpty: number; skippedExample: number;
  updates: { rowNumber: number; key: string; changes: FieldChange[] }[]; updatesTruncated: boolean;
}
export interface Period { from: string; to: string; label: string }
export interface Preview {
  stagedUploadId: string; expiresAt: string; filename: string; fileHash: string; templateVersion: string;
  period: Period | null; tables: TablePreview[];
  totals: { insert: number; update: number; unchanged: number; examplesSkipped: number };
  newBrands: string[]; issues: Issue[]; errorCount: number; warningCount: number;
  duplicateOf: { batchId: number; uploadedAt: string; uploadedBy: string | null } | null;
  requiresNewBrandConfirmation: boolean; nothingToImport: boolean; canCommit: boolean;
}
export interface CommitResult {
  batchId: number; period: Period | null;
  totals: { inserted: number; updated: number; unchanged: number; examplesSkipped: number };
  tables: { id: TableId; label: string; inserted: number; updated: number; unchanged: number }[];
  newBrandsCreated: string[];
}
export interface BatchItem {
  batchId: number; filename: string; fileHash: string; templateVersion: string;
  uploadedBy: { id: number | null; name: string | null }; uploadedAt: string;
  status: 'SUCCESS' | 'FAILED' | 'ROLLED_BACK'; period: Period | null;
  totals: { inserted: number; updated: number; unchanged: number; examplesSkipped: number } | null;
  canRollback: boolean; rolledBackAt: string | null; rolledBackBy: string | null; rollbackReason: string | null;
  errorMessage: string | null;
}
export interface BatchDetail extends BatchItem {
  tables: { id: TableId; label: string; inserted: number; updated: number; unchanged: number }[];
  warnings: Issue[]; newBrands: string[];
}

export class MarcomApiError extends Error {
  status: number;
  code?: string;
  payload?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, payload?: Record<string, unknown>) {
    super(message);
    this.name = 'MarcomApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function fail(res: Response): Promise<never> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  let payload: Record<string, unknown> | undefined;
  try {
    const body = await res.json();
    if (body && typeof body === 'object') {
      payload = body as Record<string, unknown>;
      if (typeof payload.error === 'string') message = payload.error;
      if (typeof payload.code === 'string') code = payload.code;
    }
  } catch {
    // keep the generic message; never surface raw parse errors
  }
  throw new MarcomApiError(res.status, message, code, payload);
}

async function call(path: string, token: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...auth(token), ...(init?.headers ?? {}) } });
  } catch {
    throw new MarcomApiError(0, 'Could not reach the server. It may be offline or unreachable.', 'NETWORK');
  }
  if (!res.ok) await fail(res);
  return res;
}

async function json<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return (await call(path, token, init)).json() as Promise<T>;
}
function post<T>(path: string, token: string, body: unknown): Promise<T> {
  return json<T>(path, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Saves a blob through a temporary link (the auth header rules out a plain <a href>). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const marcomApi = {
  downloadTemplate: async (token: string) =>
    saveBlob(await (await call('/marcom/upload/template', token)).blob(), 'MARCOM_Contribution_Data_Template.xlsx'),

  /** Multipart upload with progress (fetch has no upload progress, hence XHR). */
  validate: (token: string, file: File, onProgress: (pct: number) => void): Promise<Preview> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/marcom/upload/validate`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onerror = () => reject(new MarcomApiError(0, 'Could not reach the server. It may be offline or unreachable.', 'NETWORK'));
      xhr.onload = () => {
        const body = xhr.response as (Preview & { error?: string; code?: string }) | null;
        if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
        else reject(new MarcomApiError(xhr.status, body?.error ?? `Request failed (${xhr.status})`, body?.code));
      };
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    }),

  commit: (token: string, stagedUploadId: string, confirmNewBrands: boolean) =>
    post<CommitResult>('/marcom/upload/commit', token, { stagedUploadId, confirmNewBrands }),

  downloadErrorReport: async (token: string, stagedUploadId: string) =>
    saveBlob(await (await call(`/marcom/upload/staged/${stagedUploadId}/errors.csv`, token)).blob(), 'marcom-upload-report.csv'),

  listBatches: (token: string, page = 1, pageSize = 25) =>
    json<{ rows: BatchItem[]; total: number; page: number; pageSize: number }>(
      `/marcom/upload/batches?page=${page}&pageSize=${pageSize}`, token),
  getBatch: (token: string, id: number) => json<BatchDetail>(`/marcom/upload/batches/${id}`, token),
  downloadBatchFile: async (token: string, id: number) =>
    saveBlob(await (await call(`/marcom/upload/batches/${id}/file`, token)).blob(), `MARCOM_upload_batch_${id}.xlsx`),
  rollback: (token: string, id: number, reason: string) =>
    post<{ batchId: number }>(`/marcom/upload/batches/${id}/rollback`, token, { reason }),
};
