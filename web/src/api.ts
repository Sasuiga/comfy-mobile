import type {
  AppConfigPublic,
  ConnectionTestResult,
  FormOverrides,
  Preset,
  RunRecord,
  RunSummary,
  SavePresetRequest,
  SubmitRunRequest,
  SubmitRunResponse,
  UpdateConfigRequest,
  UploadResponse,
  WorkflowDetail,
  WorkflowSummary,
} from '@comfy-mobile/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEY = 'comfy-mobile.token';
const COOKIE_NAME = 'comfy_mobile_token';

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode / blocked storage: requests still accept the in-memory token.
  }
  try {
    if (token) {
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
    } else {
      document.cookie = `${COOKIE_NAME}=; path=/; Max-Age=0; SameSite=Strict`;
    }
  } catch {
    // ignore
  }
}

function restoreCookie(): void {
  const token = getToken();
  if (token) setToken(token);
}

restoreCookie();

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('accept', 'application/json');
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? `网络请求失败：${error.message}` : '网络请求失败',
      0,
      'NETWORK_ERROR',
    );
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    let code = 'HTTP_ERROR';
    let details: unknown;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string; details?: unknown };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
      details = body.error?.details;
    } catch {
      // Keep the generic message.
    }
    throw new ApiError(message, response.status, code, details);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  getConfig: () => request<AppConfigPublic>('/config'),
  saveConfig: (body: UpdateConfigRequest) =>
    request<{ config: AppConfigPublic; test: ConnectionTestResult }>('/config', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  testConnection: (body: UpdateConfigRequest) =>
    request<ConnectionTestResult>('/config/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  refreshCaches: () =>
    request<{ ok: boolean; objectInfoHash?: string; workflowCount?: number }>(
      '/config/refresh',
      { method: 'POST', body: JSON.stringify({}) },
    ),

  listWorkflows: (refresh = false) =>
    request<{ items: WorkflowSummary[] }>(`/workflows${refresh ? '?refresh=1' : ''}`),
  getWorkflow: (key: string) =>
    request<WorkflowDetail>(`/workflows/${encodeURIComponent(key)}`),
  saveFields: (key: string, fields: FormOverrides['fields']) =>
    request<WorkflowDetail>(`/workflows/${encodeURIComponent(key)}/fields`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    }),
  resetFields: (key: string) =>
    request<WorkflowDetail>(`/workflows/${encodeURIComponent(key)}/fields`, {
      method: 'DELETE',
    }),
  importWorkflow: (name: string, workflow: unknown) =>
    request<{ item: WorkflowSummary }>('/workflows/import', {
      method: 'POST',
      body: JSON.stringify({ name, workflow }),
    }),
  deleteWorkflow: (key: string) =>
    request<{ ok: boolean }>(`/workflows/${encodeURIComponent(key)}`, { method: 'DELETE' }),

  listPresets: (key: string) =>
    request<{ presets: Preset[] }>(`/workflows/${encodeURIComponent(key)}/presets`),
  createPreset: (key: string, body: SavePresetRequest) =>
    request<{ preset: Preset }>(`/workflows/${encodeURIComponent(key)}/presets`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deletePreset: (key: string, id: string) =>
    request<{ ok: boolean }>(
      `/workflows/${encodeURIComponent(key)}/presets/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<UploadResponse>('/uploads', { method: 'POST', body: form });
  },

  submitRun: (body: SubmitRunRequest) =>
    request<SubmitRunResponse>('/runs', { method: 'POST', body: JSON.stringify(body) }),
  listRuns: (limit = 50) => request<{ items: RunSummary[] }>(`/runs?limit=${limit}`),
  getRun: (id: string) => request<RunRecord>(`/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) =>
    request<RunRecord>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  version: () => request<{ name: string; version: string }>('/version'),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function outputUrl(runId: string, key: string, thumb = false): string {
  return `/api/outputs/${encodeURIComponent(runId)}/${encodeURIComponent(key)}${
    thumb ? '?thumb=1' : ''
  }`;
}
