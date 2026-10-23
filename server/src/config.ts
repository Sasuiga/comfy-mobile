import { fileURLToPath } from 'node:url';
import type {
  AppConfigPublic,
  ComfyCapabilities,
  UpdateConfigRequest,
} from '@comfy-mobile/shared';
import type { JsonStore } from './store/jsonStore.js';
import { AppError } from './errors.js';

const CONFIG_PATH = 'config.json';
// server/src/config.ts (dev) and server/dist/index.js (bundled) are both two
// levels below the repository root, so these defaults work no matter which
// directory the process was started from.
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../data', import.meta.url));

export interface StoredConfig {
  comfyUrl?: string;
  comfyToken?: string;
  comfyHeaders?: Record<string, string>;
  comfyInsecure?: boolean;
}

export interface ComfySettings {
  baseUrl: string;
  token: string;
  headers: Record<string, string>;
  insecure: boolean;
}

export interface ConnectionStatus {
  connected: boolean;
  version?: string;
  capabilities?: ComfyCapabilities;
}

export interface RuntimeOptions {
  port: number;
  host: string;
  dataDir: string;
  webDist: string;
  authToken: string;
  maxUploadMb: number;
  logLevel: string;
  comfyUrlEnv?: string;
  comfyTokenEnv?: string;
  comfyHeadersEnv?: Record<string, string>;
  comfyInsecureEnv?: boolean;
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof raw === 'string') headers[key] = raw;
    }
    return headers;
  } catch (error) {
    throw new Error(
      `COMFYUI_HEADERS is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeComfyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'ComfyUI 地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'INVALID_URL', 'ComfyUI 地址只支持 http 或 https');
  }
  if (url.username || url.password) {
    throw new AppError(400, 'INVALID_URL', '请不要把用户名密码写进地址，使用访问令牌设置');
  }
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  if (path === '/' || path === '') path = '';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function readRuntimeOptions(env: NodeJS.ProcessEnv = process.env): RuntimeOptions {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const maxUploadMb = Number(env.UPLOAD_MAX_MB || 20);
  if (!Number.isFinite(maxUploadMb) || maxUploadMb <= 0) {
    throw new Error('UPLOAD_MAX_MB must be a positive number');
  }
  const comfyUrlEnv = env.COMFYUI_URL?.trim() || undefined;
  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || DEFAULT_DATA_DIR,
    webDist: env.WEB_DIST || DEFAULT_WEB_DIST,
    authToken: env.AUTH_TOKEN || '',
    maxUploadMb,
    logLevel: env.LOG_LEVEL || 'info',
    comfyUrlEnv: comfyUrlEnv ? normalizeComfyUrl(comfyUrlEnv) : undefined,
    comfyTokenEnv: env.COMFYUI_TOKEN?.trim() || undefined,
    comfyHeadersEnv: parseHeaders(env.COMFYUI_HEADERS),
    comfyInsecureEnv: envBool(env.COMFYUI_INSECURE),
  };
}

export class ConfigService {
  private stored: StoredConfig = {};
  private status: ConnectionStatus = { connected: false };

  constructor(
    private readonly store: JsonStore,
    readonly options: RuntimeOptions,
  ) {}

  async load(): Promise<void> {
    this.stored = await this.store.read<StoredConfig>(CONFIG_PATH, {});
    if (this.options.comfyUrlEnv) {
      // Validate eagerly so a bad deployment fails at startup, not on first use.
      normalizeComfyUrl(this.options.comfyUrlEnv);
    }
  }

  get comfy(): ComfySettings {
    const storedHeaders = this.stored.comfyHeaders ?? {};
    const headers = { ...storedHeaders, ...(this.options.comfyHeadersEnv ?? {}) };
    return {
      baseUrl: this.options.comfyUrlEnv ?? this.stored.comfyUrl ?? '',
      token: this.options.comfyTokenEnv ?? this.stored.comfyToken ?? '',
      headers,
      insecure: this.options.comfyInsecureEnv ?? this.stored.comfyInsecure ?? false,
    };
  }

  get authToken(): string {
    return this.options.authToken;
  }

  get maxUploadBytes(): number {
    return Math.floor(this.options.maxUploadMb * 1024 * 1024);
  }

  get locked(): { comfyUrl: boolean; token: boolean } {
    return {
      comfyUrl: this.options.comfyUrlEnv !== undefined,
      token: this.options.comfyTokenEnv !== undefined,
    };
  }

  get setupRequired(): boolean {
    return !this.comfy.baseUrl;
  }

  publicView(): AppConfigPublic {
    const settings = this.comfy;
    const tokenSource: 'env' | 'config' | 'none' = this.options.comfyTokenEnv
      ? 'env'
      : this.stored.comfyToken
        ? 'config'
        : 'none';
    return {
      comfyUrl: settings.baseUrl,
      hasToken: Boolean(settings.token),
      tokenSource,
      locked: this.locked,
      connected: this.status.connected,
      comfyVersion: this.status.version,
      capabilities: this.status.capabilities,
      setupRequired: this.setupRequired,
      maxUploadMb: this.options.maxUploadMb,
    };
  }

  setConnectionStatus(status: ConnectionStatus): void {
    this.status = status;
  }

  markDisconnected(): void {
    this.status = { connected: false };
  }

  async update(request: UpdateConfigRequest): Promise<void> {
    const next: StoredConfig = { ...this.stored };
    if (request.comfyUrl !== undefined && !this.locked.comfyUrl) {
      next.comfyUrl = normalizeComfyUrl(request.comfyUrl);
    }
    if (request.token !== undefined && !this.locked.token) {
      const token = request.token === null ? '' : request.token.trim();
      if (token) next.comfyToken = token;
      else delete next.comfyToken;
    }
    if (request.headers !== undefined) {
      if (request.headers === null) {
        delete next.comfyHeaders;
      } else {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          const name = key.trim();
          if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(String(value))) {
            throw new AppError(400, 'INVALID_HEADER', `请求头不合法: ${key}`);
          }
          headers[name] = String(value);
        }
        next.comfyHeaders = headers;
      }
    }
    if (request.insecure !== undefined) {
      next.comfyInsecure = Boolean(request.insecure);
    }
    this.stored = next;
    await this.store.write(CONFIG_PATH, next);
    this.markDisconnected();
  }
}
