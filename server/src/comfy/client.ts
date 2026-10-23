import type { ComfyCapabilities, ConnectionTestResult } from '@comfy-mobile/shared';
import { Agent, fetch as undiciFetch, FormData as UndiciFormData } from 'undici';
import type { ConfigService, ComfySettings } from '../config.js';
import { ComfyError, toErrorMessage } from '../errors.js';
import { encodePathSegments } from '../security.js';

export interface PromptNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ApiPrompt = Record<string, PromptNode>;

export interface HistoryEntry {
  prompt?: unknown[];
  outputs?: Record<string, Record<string, unknown>>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

export interface QueueState {
  running: unknown[];
  pending: unknown[];
}

export interface UserDataItem {
  path: string;
  name: string;
  modified?: number;
  size?: number;
}

export interface UploadResult {
  name: string;
  subfolder: string;
  type: string;
  assetHash?: string;
}

interface RawUserDataItem {
  path?: unknown;
  name?: unknown;
  type?: unknown;
  modified?: unknown;
  mtime?: unknown;
  size?: unknown;
}

const DEFAULT_CAPABILITIES: ComfyCapabilities = {
  userdata: false,
  prompt: true,
  websocket: true,
  historyV2: false,
  jobs: false,
  uploadAssetHash: false,
  systemStats: false,
};

function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function normalizeMtime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return normalizeMtime(asNumber);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function normalizeUserData(data: unknown): UserDataItem[] {
  let items: unknown[] = [];
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.files)) items = record.files;
    else if (Array.isArray(record.items)) items = record.items;
    else if (Array.isArray(record.data)) items = record.data;
  }
  const result = new Map<string, UserDataItem>();
  for (const item of items) {
    let path: string | undefined;
    let name: string | undefined;
    let modified: number | undefined;
    let size: number | undefined;
    if (typeof item === 'string') {
      path = item;
    } else if (item && typeof item === 'object') {
      const raw = item as RawUserDataItem;
      if (typeof raw.type === 'string' && raw.type !== 'file' && raw.type !== '') continue;
      path = typeof raw.path === 'string' ? raw.path : undefined;
      name = typeof raw.name === 'string' ? raw.name : undefined;
      modified = normalizeMtime(raw.modified ?? raw.mtime);
      size = typeof raw.size === 'number' ? raw.size : undefined;
    }
    if (!path && name) path = name;
    if (!path) continue;
    path = path.replace(/^\/+/, '');
    if (!path.startsWith('workflows/')) {
      if (name && name.startsWith('workflows/')) path = name;
      else path = `workflows/${path}`;
    }
    if (!path.toLowerCase().endsWith('.json')) continue;
    if (path.split('/').some((part) => part === '..' || part === '.')) continue;
    const baseName = path.split('/').pop() ?? path;
    result.set(path, {
      path,
      name: baseName.replace(/\.json$/i, ''),
      modified,
      size,
    });
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class ComfyClient {
  private insecureAgent?: Agent;

  constructor(private readonly config: ConfigService) {}

  get settings(): ComfySettings {
    return this.config.comfy;
  }

  get baseUrl(): string {
    return this.settings.baseUrl;
  }

  get clientId(): string {
    return this.comfyClientId;
  }

  private comfyClientId = `comfy-mobile-${crypto.randomUUID()}`;

  dispose(): void {
    if (this.insecureAgent) {
      void this.insecureAgent.close();
      this.insecureAgent = undefined;
    }
  }

  private buildHeaders(
    extra?: ConstructorParameters<typeof Headers>[0],
    bodyIsForm = false,
  ): Headers {
    const settings = this.settings;
    const headers = new Headers(extra);
    if (!bodyIsForm && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    headers.set('accept', headers.get('accept') ?? 'application/json');
    for (const [key, value] of Object.entries(settings.headers)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    if (settings.token && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${settings.token}`);
    }
    return headers;
  }

  private dispatcher(): Agent | undefined {
    if (!this.settings.insecure) return undefined;
    if (!this.insecureAgent) {
      this.insecureAgent = new Agent({
        connect: { rejectUnauthorized: false },
        keepAliveTimeout: 10_000,
      });
    }
    return this.insecureAgent;
  }

  private async fetchSafe(
    url: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
    followRedirects = true,
  ): Promise<Response> {
    let current = new URL(url);
    const originalOrigin = current.origin;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal =
        init.signal && timeout
          ? AbortSignal.any([init.signal, timeout])
          : (init.signal ?? timeout);
      let response: Response;
      try {
        response = (await undiciFetch(current.toString(), {
          ...init,
          redirect: 'manual',
          ...(signal ? { signal } : {}),
          ...(this.dispatcher() ? { dispatcher: this.dispatcher() } : {}),
        } as never)) as unknown as Response;
      } catch (error) {
        const message = toErrorMessage(error);
        if ((error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
          throw new ComfyError(504, 'COMFY_TIMEOUT', '连接 ComfyUI 超时', { message });
        }
        throw new ComfyError(502, 'COMFY_UNREACHABLE', `无法连接 ComfyUI：${message}`, {
          message,
        });
      }
      if (!followRedirects || !isRedirect(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      const next = new URL(location, current);
      if (next.origin !== originalOrigin) {
        throw new ComfyError(502, 'COMFY_REDIRECT', 'ComfyUI 重定向到了其他主机，已拒绝');
      }
      current = next;
    }
    throw new ComfyError(502, 'COMFY_REDIRECT', 'ComfyUI 重定向次数过多');
  }

  private async parseError(response: Response): Promise<ComfyError> {
    const text = await response.text().catch(() => '');
    let details: unknown = text;
    let message = `ComfyUI 返回 ${response.status}`;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      details = parsed;
      if (parsed.node_errors && typeof parsed.node_errors === 'object') {
        message = 'ComfyUI 拒绝了工作流，请检查节点参数';
      } else if (typeof parsed.error === 'string') {
        message = parsed.error;
      } else if (parsed.error && typeof parsed.error === 'object') {
        const err = parsed.error as Record<string, unknown>;
        if (typeof err.message === 'string') message = err.message;
        if (typeof err.type === 'string') message = `${err.type}: ${message}`;
      }
    } catch {
      if (text.trim()) message = text.trim().slice(0, 500);
    }
    let code = 'COMFY_ERROR';
    if (response.status === 401 || response.status === 403) code = 'COMFY_AUTH';
    else if (response.status === 404) code = 'COMFY_NOT_FOUND';
    else if (response.status === 429) code = 'COMFY_BUSY';
    else if (response.status >= 500) code = 'COMFY_SERVER_ERROR';
    const error = new ComfyError(
      response.status === 401 || response.status === 403 ? 502 : response.status,
      code,
      message,
      { status: response.status, body: details },
    );
    const retry = parseRetryAfter(response.headers.get('retry-after'));
    if (retry !== undefined) {
      (error.details as Record<string, unknown>).retryAfterMs = retry;
    }
    return error;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
    preferApiPrefix = true,
  ): Promise<Response> {
    if (!this.baseUrl) {
      throw new ComfyError(400, 'COMFY_NOT_CONFIGURED', '尚未配置 ComfyUI 地址');
    }
    const candidates = preferApiPrefix ? [`/api${path}`, path] : [path];
    const headers = this.buildHeaders(init.headers, init.body instanceof UndiciFormData);
    const requestInit: RequestInit = { ...init, headers };
    let lastNotFound: Response | undefined;
    for (const candidate of candidates) {
      const url = joinBaseUrl(this.baseUrl, candidate);
      const response = await this.fetchSafe(url, requestInit, timeoutMs);
      if (response.status === 404 && candidate !== candidates[candidates.length - 1]) {
        lastNotFound = response;
        continue;
      }
      return response;
    }
    return lastNotFound as Response;
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const response = await this.request(path, init, timeoutMs);
    if (!response.ok) throw await this.parseError(response);
    const text = await response.text();
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ComfyError(502, 'COMFY_BAD_JSON', 'ComfyUI 返回了无法解析的数据', {
        preview: text.slice(0, 500),
      });
    }
  }

  private jsonBody(value: unknown): RequestInit {
    return {
      method: 'POST',
      body: JSON.stringify(value),
    };
  }

  async listWorkflows(timeoutMs = 20_000): Promise<UserDataItem[]> {
    const data = await this.requestJson<unknown>(
      '/userdata?dir=workflows&recurse=true&full_info=true',
      { method: 'GET' },
      timeoutMs,
    );
    return normalizeUserData(data);
  }

  async readWorkflow(path: string, timeoutMs = 30_000): Promise<unknown> {
    const raw = await this.requestJson<unknown>(
      `/userdata/${encodePathSegments(path)}`,
      { method: 'GET' },
      timeoutMs,
    );
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        throw new ComfyError(502, 'BAD_WORKFLOW', '工作流文件不是合法 JSON');
      }
    }
    if (raw && typeof raw === 'object') {
      const record = raw as Record<string, unknown>;
      if (typeof record.content === 'string') {
        try {
          return JSON.parse(record.content);
        } catch {
          throw new ComfyError(502, 'BAD_WORKFLOW', '工作流文件不是合法 JSON');
        }
      }
      if (typeof record.data === 'string' && record.content === undefined) {
        try {
          return JSON.parse(record.data);
        } catch {
          // fall through and return the object
        }
      }
    }
    return raw;
  }

  async getObjectInfo(force = false, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    void force;
    const data = await this.requestJson<Record<string, unknown>>(
      '/object_info',
      { method: 'GET' },
      timeoutMs,
    );
    if (!data || typeof data !== 'object') {
      throw new ComfyError(502, 'BAD_OBJECT_INFO', 'ComfyUI object_info 格式不正确');
    }
    return data;
  }

  async submitPrompt(prompt: ApiPrompt, timeoutMs = 30_000): Promise<{ promptId: string; number?: number }> {
    const response = await this.requestJson<{
      prompt_id?: string;
      number?: number;
      node_errors?: unknown;
    }>(
      '/prompt',
      this.jsonBody({ prompt, client_id: this.comfyClientId }),
      timeoutMs,
    );
    if (!response?.prompt_id) {
      throw new ComfyError(502, 'PROMPT_REJECTED', 'ComfyUI 没有返回 prompt_id', response);
    }
    return { promptId: response.prompt_id, number: response.number };
  }

  async getHistory(promptId: string, timeoutMs = 15_000): Promise<HistoryEntry | null> {
    const data = await this.requestJson<Record<string, HistoryEntry>>(
      `/history/${encodeURIComponent(promptId)}`,
      { method: 'GET' },
      timeoutMs,
    );
    if (!data || typeof data !== 'object') return null;
    if (data[promptId]) return data[promptId];
    // Some builds return the entry itself rather than a map keyed by prompt id.
    const record = data as Record<string, unknown>;
    if (record.outputs || record.status || record.prompt) {
      return data as unknown as HistoryEntry;
    }
    return null;
  }

  async getHistoryV2(promptId: string, timeoutMs = 15_000): Promise<HistoryEntry | null> {
    try {
      const data = await this.requestJson<unknown>(
        `/history_v2?max_items=10&prompt_id=${encodeURIComponent(promptId)}`,
        { method: 'GET' },
        timeoutMs,
      );
      if (!data || typeof data !== 'object') return null;
      const record = data as Record<string, unknown>;
      const history = (record.history ?? record.items ?? record) as unknown;
      if (Array.isArray(history)) {
        const found = history.find((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const e = entry as Record<string, unknown>;
          return e.prompt_id === promptId || e.id === promptId;
        });
        if (found && typeof found === 'object') return found as HistoryEntry;
        return history.length ? (history[0] as HistoryEntry) : null;
      }
      if (history && typeof history === 'object') {
        const map = history as Record<string, HistoryEntry>;
        if (map[promptId]) return map[promptId];
        const values = Object.values(map);
        return values.length ? values[values.length - 1] : null;
      }
      return null;
    } catch (error) {
      if (error instanceof ComfyError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async getQueue(timeoutMs = 15_000): Promise<QueueState> {
    const data = await this.requestJson<Record<string, unknown>>(
      '/queue',
      { method: 'GET' },
      timeoutMs,
    );
    return {
      running: Array.isArray(data?.queue_running) ? data.queue_running : [],
      pending: Array.isArray(data?.queue_pending) ? data.queue_pending : [],
    };
  }

  async interrupt(timeoutMs = 15_000): Promise<void> {
    const response = await this.request('/interrupt', { method: 'POST', body: '' }, timeoutMs);
    if (!response.ok) throw await this.parseError(response);
  }

  async deleteQueueItems(promptIds: string[], timeoutMs = 15_000): Promise<void> {
    const response = await this.request(
      '/queue',
      this.jsonBody({ delete: promptIds }),
      timeoutMs,
    );
    if (!response.ok) throw await this.parseError(response);
  }

  async cancelJob(promptId: string, timeoutMs = 10_000): Promise<boolean> {
    try {
      const response = await this.request(
        `/jobs/${encodeURIComponent(promptId)}/cancel`,
        { method: 'POST', body: '' },
        timeoutMs,
      );
      if (response.ok) return true;
      if (response.status === 404) return false;
      throw await this.parseError(response);
    } catch (error) {
      if (error instanceof ComfyError && error.statusCode === 404) return false;
      throw error;
    }
  }

  async uploadFile(
    data: Uint8Array,
    filename: string,
    mimeType: string,
    type = 'input',
    timeoutMs = 60_000,
  ): Promise<UploadResult> {
    const form = new UndiciFormData();
    const blob = new Blob([new Uint8Array(data)], { type: mimeType || 'application/octet-stream' });
    form.append('image', blob, filename);
    form.append('type', type);
    form.append('overwrite', 'true');
    const response = await this.request(
      '/upload/image',
      {
        method: 'POST',
        body: form,
        headers: { accept: 'application/json' },
      },
      timeoutMs,
    );
    if (!response.ok) throw await this.parseError(response);
    const result = (await response.json()) as Record<string, unknown>;
    const name = typeof result.name === 'string' ? result.name : filename;
    return {
      name,
      subfolder: typeof result.subfolder === 'string' ? result.subfolder : '',
      type: typeof result.type === 'string' ? result.type : type,
      assetHash:
        typeof result.asset_hash === 'string'
          ? result.asset_hash
          : typeof result.assetHash === 'string'
            ? result.assetHash
            : undefined,
    };
  }

  async getView(
    file: { filename: string; subfolder?: string; type?: string },
    options: { preview?: string; range?: string; signal?: AbortSignal; thumb?: boolean } = {},
  ): Promise<Response> {
    const query = new URLSearchParams();
    query.set('filename', file.filename);
    query.set('subfolder', file.subfolder ?? '');
    query.set('type', file.type ?? 'output');
    if (options.preview) query.set('preview', options.preview);
    else if (options.thumb) query.set('preview', 'webp;90');
    const headers: Record<string, string> = {};
    if (options.range) headers.range = options.range;
    const response = await this.request(
      `/view?${query.toString()}`,
      { method: 'GET', headers, signal: options.signal },
      0,
    );
    return response;
  }

  async testConnection(overrides?: {
    baseUrl?: string;
    token?: string;
    headers?: Record<string, string>;
    insecure?: boolean;
  }): Promise<ConnectionTestResult> {
    const started = Date.now();
    const original = this.settings;
    const baseUrl = overrides?.baseUrl || original.baseUrl;
    if (!baseUrl) {
      return {
        ok: false,
        latencyMs: 0,
        capabilities: DEFAULT_CAPABILITIES,
        error: '尚未填写 ComfyUI 地址',
      };
    }
    // Temporarily use the caller's settings for the probes. The config object is
    // not mutated; probes accept an explicit base URL through a small override.
    const settings: ComfySettings = {
      baseUrl,
      token:
        overrides && Object.prototype.hasOwnProperty.call(overrides, 'token')
          ? overrides.token ?? ''
          : original.token,
      headers: { ...original.headers, ...(overrides?.headers ?? {}) },
      insecure:
        overrides && Object.prototype.hasOwnProperty.call(overrides, 'insecure')
          ? Boolean(overrides.insecure)
          : original.insecure,
    };
    const capabilities: ComfyCapabilities = { ...DEFAULT_CAPABILITIES };
    const probe = async (
      path: string,
      timeout = 8_000,
    ): Promise<{ ok: boolean; data?: unknown; status?: number }> => {
      const url = joinBaseUrl(settings.baseUrl, path);
      const headers = new Headers();
      if (settings.token && !settings.headers.authorization) {
        headers.set('authorization', `Bearer ${settings.token}`);
      }
      for (const [key, value] of Object.entries(settings.headers)) headers.set(key, value);
      const dispatcher = settings.insecure
        ? this.insecureAgent ??
          (this.insecureAgent = new Agent({
            connect: { rejectUnauthorized: false },
            keepAliveTimeout: 10_000,
          }))
        : undefined;
      try {
        const response = (await undiciFetch(url, {
          headers,
          signal: AbortSignal.timeout(timeout),
          ...(dispatcher ? { dispatcher } : {}),
        } as never)) as unknown as Response;
        let data: unknown;
        if (response.ok) {
          const text = await response.text();
          if (text.trim()) {
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
          }
        }
        return { ok: response.ok, data, status: response.status };
      } catch {
        return { ok: false };
      }
    };

    const [stats, features, workflows, historyV2, jobs] = await Promise.all([
      probe('/api/system_stats'),
      probe('/api/features'),
      probe('/api/userdata?dir=workflows&recurse=true&full_info=true'),
      probe('/api/history_v2?max_items=1'),
      probe('/api/jobs?limit=1'),
    ]);

    const reachable = stats.ok || features.ok || workflows.ok || historyV2.ok || jobs.ok;
    if (!reachable) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        capabilities,
        error: '无法连接 ComfyUI，请检查地址、端口转发和证书',
      };
    }

    capabilities.systemStats = stats.ok;
    capabilities.userdata = workflows.ok;
    capabilities.historyV2 = historyV2.ok;
    capabilities.jobs = jobs.ok;
    capabilities.websocket = true;

    let version: string | undefined;
    const statsData = stats.data as Record<string, unknown> | undefined;
    const system = statsData?.system as Record<string, unknown> | undefined;
    if (typeof system?.comfyui_version === 'string') version = system.comfyui_version;
    if (!version && typeof statsData?.comfyui_version === 'string') {
      version = statsData.comfyui_version;
    }

    const workflowCount = workflows.ok
      ? normalizeUserData(workflows.data).length
      : undefined;

    let warning: string | undefined;
    if (!workflows.ok) warning = 'ComfyUI 可访问，但无法读取工作流列表，请确认用户目录接口可用';
    else if (!stats.ok) warning = 'ComfyUI 可访问，但无法读取版本信息';

    return {
      ok: true,
      latencyMs: Date.now() - started,
      comfyVersion: version,
      workflowCount,
      capabilities,
      warning,
    };
  }

  wsUrl(): string {
    const settings = this.settings;
    const base = new URL(settings.baseUrl);
    const path = `${base.pathname.replace(/\/+$/, '')}/ws`;
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = path;
    base.search = `?clientId=${encodeURIComponent(this.comfyClientId)}`;
    return base.toString();
  }
}
