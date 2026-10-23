import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ConfigService } from '../config.js';
import type { ComfyClient } from './client.js';

export interface ComfySocketEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface ComfySocketStatus {
  connected: boolean;
  error?: string;
  reconnectInMs?: number;
}

/**
 * A single shared WebSocket to ComfyUI. Runs use one prompt id each; ComfyUI
 * broadcasts events for all prompts on the connection, so one socket is enough.
 */
export class ComfySocket extends EventEmitter {
  private socket?: WebSocket;
  private stopped = true;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private alive = true;
  private lastError?: string;

  constructor(
    private readonly client: ComfyClient,
    private readonly config: ConfigService,
  ) {
    super();
    this.setMaxListeners(0);
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.removeAllListeners();
    // Closing a socket that is still connecting makes ws emit an asynchronous
    // "WebSocket was closed before the connection was established" error.
    // Swallow it and terminate instead of leaving an unhandled 'error' event.
    socket.on('error', () => undefined);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
  }

  refresh(): void {
    this.stop();
    this.start();
  }

  private emitStatus(status: ComfySocketStatus): void {
    this.emit('status', status);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.emitStatus({ connected: false, error: this.lastError, reconnectInMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.config.comfy.baseUrl) {
      this.lastError = '尚未配置 ComfyUI 地址';
      this.emitStatus({ connected: false, error: this.lastError });
      return;
    }
    const previous = this.socket;
    if (previous) {
      previous.removeAllListeners();
      previous.on('error', () => undefined);
      previous.terminate();
    }
    this.socket = undefined;

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.client.wsUrl(), {
        headers: this.authHeaders(),
        rejectUnauthorized: !this.config.comfy.insecure,
        handshakeTimeout: 15_000,
        maxPayload: 8 * 1024 * 1024,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.alive = true;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.lastError = undefined;
      this.emitStatus({ connected: true });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (!this.alive) {
          socket.terminate();
          return;
        }
        this.alive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }, 25_000);
      this.pingTimer.unref?.();
    });

    socket.on('pong', () => {
      this.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.emit('binary', data);
        return;
      }
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const record = parsed as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';
      if (!type) return;
      const dataObject =
        record.data && typeof record.data === 'object'
          ? (record.data as Record<string, unknown>)
          : {};
      this.emit('event', { type, data: dataObject } satisfies ComfySocketEvent);
    });

    socket.on('error', (error) => {
      this.lastError = error.message;
    });

    socket.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      this.emitStatus({ connected: false, error: this.lastError });
      this.scheduleReconnect();
    });
  }

  private authHeaders(): Record<string, string> {
    const settings = this.config.comfy;
    const headers = { ...settings.headers };
    if (settings.token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
      headers.authorization = `Bearer ${settings.token}`;
    }
    return headers;
  }
}
