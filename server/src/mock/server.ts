import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  MOCK_TEMPLATE_INDEX,
  MOCK_TEMPLATES,
  MOCK_THUMBNAIL_PNG,
  MOCK_WORKFLOWS,
  mockObjectInfo,
} from './fixtures.js';

export interface MockComfyOptions {
  port?: number;
  host?: string;
  token?: string;
  stepDelayMs?: number;
  autoRun?: boolean;
  workflows?: Record<string, unknown>;
  objectInfo?: Record<string, unknown>;
  templates?: Record<string, unknown>;
}

interface MockJob {
  id: string;
  number: number;
  prompt: Record<string, unknown>;
  clientId?: string;
  state: 'pending' | 'running' | 'done' | 'canceled';
  timers: Set<NodeJS.Timeout>;
  cancelled: boolean;
  outputFiles: { filename: string; subfolder: string; type: string }[];
}

interface RecordedRequest {
  method: string;
  url: string;
  body?: string;
}

export interface MockComfyState {
  requests: RecordedRequest[];
  prompts: Map<string, MockJob>;
  history: Map<string, Record<string, unknown>>;
  uploads: Map<string, { filename: string; contentType: string; data: Buffer }>;
  outputFiles: Map<string, { contentType: string; data: Buffer }>;
  clients: Set<WebSocket>;
  running: MockJob | null;
  pending: MockJob[];
  nextNumber: number;
  token?: string;
}

export interface MockComfyServer {
  url: string;
  port: number;
  state: MockComfyState;
  close: () => Promise<void>;
  broadcast: (type: string, data: Record<string, unknown>) => void;
  emitProgress: (promptId: string, value: number, max: number, node?: string) => void;
}

const PNG_BUFFER = Buffer.from(MOCK_THUMBNAIL_PNG, 'base64');

function contentTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mp3') return 'audio/mpeg';
  return 'application/octet-stream';
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipartFile(
  body: Buffer,
  contentType: string,
): { filename: string; data: Buffer; contentType: string } | null {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary}`);
  let offset = body.indexOf(delimiter);
  while (offset >= 0) {
    const headerStart = offset + delimiter.length + 2;
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd < 0) return null;
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0) return null;
    const data = body.subarray(headerEnd + 4, next - 2);
    if (/name="image"/i.test(headers)) {
      const filenameMatch = /filename="([^"]*)"/i.exec(headers);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headers);
      return {
        filename: filenameMatch?.[1] || 'upload.png',
        data: Buffer.from(data),
        contentType: typeMatch?.[1]?.trim() || contentTypeFor(filenameMatch?.[1] || ''),
      };
    }
    offset = next;
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-一-鿿]+/g, '_').slice(0, 120) || 'upload.png';
}

function parseJobIndex(path: string): string | null {
  const match = /^\/jobs\/([^/]+)\/(?:cancel|status)$/.exec(path);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

export async function createMockComfyServer(
  options: MockComfyOptions = {},
): Promise<MockComfyServer> {
  const workflows = options.workflows ?? MOCK_WORKFLOWS;
  const objectInfo = options.objectInfo ?? (mockObjectInfo as unknown as Record<string, unknown>);
  const templates = options.templates ?? MOCK_TEMPLATES;
  const templateIndex = MOCK_TEMPLATE_INDEX.filter((group) =>
    group.templates.some((item) => item.name in templates),
  );
  const state: MockComfyState = {
    requests: [],
    prompts: new Map(),
    history: new Map(),
    uploads: new Map(),
    outputFiles: new Map(),
    clients: new Set(),
    running: null,
    pending: [],
    nextNumber: 1,
    token: options.token,
  };
  const autoRun = options.autoRun ?? true;
  const stepDelayMs = options.stepDelayMs ?? 8;
  const allTimers = new Set<NodeJS.Timeout>();

  const schedule = (fn: () => void, delay: number): NodeJS.Timeout => {
    const timer = setTimeout(() => {
      allTimers.delete(timer);
      fn();
    }, delay);
    allTimers.add(timer);
    return timer;
  };

  const broadcast = (type: string, data: Record<string, unknown>): void => {
    const message = JSON.stringify({ type, data });
    for (const client of state.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const emitProgress = (promptId: string, value: number, max: number, node = '5'): void => {
    broadcast('progress', { prompt_id: promptId, node, value, max });
  };

  const queueRemaining = (): number => state.pending.length + (state.running ? 1 : 0);

  const finishJob = (job: MockJob): void => {
    if (job.state === 'canceled') return;
    job.state = 'done';
    const images = job.outputFiles.map((file) => ({
      filename: file.filename,
      subfolder: file.subfolder,
      type: file.type,
    }));
    const outputs: Record<string, Record<string, unknown>> = {};
    if (images.length) outputs['7'] = { images };
    const entry = {
      prompt: [job.number, job.id, job.prompt, { client_id: job.clientId ?? '' }, []],
      outputs,
      status: {
        status_str: 'success',
        completed: true,
        messages: [['execution_start', { prompt_id: job.id }]],
      },
    };
    state.history.set(job.id, entry);
    state.prompts.set(job.id, job);
    broadcast('executing', { node: null, prompt_id: job.id });
    broadcast('status', {
      status: { exec_info: { queue_remaining: queueRemaining() } },
      sid: 'mock',
    });
    state.running = null;
  };

  const runJob = (job: MockJob): void => {
    if (job.cancelled || job.state === 'canceled') return;
    job.state = 'running';
    state.running = job;
    state.pending = state.pending.filter((item) => item.id !== job.id);
    const nodeIds = Object.keys(job.prompt).sort((a, b) => Number(a) - Number(b));
    broadcast('execution_start', { prompt_id: job.id });
    broadcast('execution_cached', { nodes: [], prompt_id: job.id });
    broadcast('status', {
      status: { exec_info: { queue_remaining: queueRemaining() } },
      sid: 'mock',
    });

    let delay = 0;
    for (const nodeId of nodeIds) {
      delay += stepDelayMs;
      schedule(() => {
        if (job.cancelled) return;
        broadcast('executing', { node: nodeId, prompt_id: job.id });
        const node = job.prompt[nodeId] as { class_type?: string } | undefined;
        if (node?.class_type === 'KSampler' || node?.class_type === 'KSamplerAdvanced') {
          for (let step = 1; step <= 4; step += 1) {
            const timer = schedule(() => {
              if (!job.cancelled) emitProgress(job.id, step, 4, nodeId);
            }, step * stepDelayMs);
            job.timers.add(timer);
          }
          delay += stepDelayMs * 4;
        }
        if (node?.class_type === 'SaveImage' || node?.class_type === 'PreviewImage') {
          const filename = `mock_${String(job.number).padStart(5, '0')}_${randomUUID().slice(0, 8)}.png`;
          const file = { filename, subfolder: '', type: 'output' };
          job.outputFiles.push(file);
          state.outputFiles.set(filename, { contentType: 'image/png', data: PNG_BUFFER });
          const timer = schedule(() => {
            if (!job.cancelled) {
              broadcast('executed', {
                node: nodeId,
                prompt_id: job.id,
                output: { images: [file] },
              });
            }
          }, stepDelayMs);
          job.timers.add(timer);
          delay += stepDelayMs;
        }
      }, delay);
    }
    delay += stepDelayMs;
    schedule(() => {
      if (job.cancelled) return;
      finishJob(job);
      const next = state.pending.shift();
      if (next) runJob(next);
    }, delay);
  };

  const enqueue = (id: string, prompt: Record<string, unknown>, clientId?: string): MockJob => {
    const job: MockJob = {
      id,
      number: state.nextNumber,
      prompt,
      clientId,
      state: 'pending',
      timers: new Set(),
      cancelled: false,
      outputFiles: [],
    };
    state.nextNumber += 1;
    state.prompts.set(id, job);
    state.pending.push(job);
    if (autoRun) {
      if (!state.running) schedule(() => runJob(job), 0);
    }
    return job;
  };

  const cancelJob = (id: string): boolean => {
    const job = state.prompts.get(id);
    if (!job) return false;
    if (job.state === 'done') return false;
    job.cancelled = true;
    job.state = 'canceled';
    for (const timer of job.timers) clearTimeout(timer);
    job.timers.clear();
    state.pending = state.pending.filter((item) => item.id !== id);
    if (state.running?.id === id) {
      state.running = null;
      broadcast('execution_interrupted', { prompt_id: id });
      const next = state.pending.shift();
      if (next && autoRun) schedule(() => runJob(next), stepDelayMs);
    }
    broadcast('status', {
      status: { exec_info: { queue_remaining: queueRemaining() } },
      sid: 'mock',
    });
    return true;
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: { message: error instanceof Error ? error.message : 'mock error' } });
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    const method = request.method ?? 'GET';
    const parsed = new URL(url, 'http://mock.local');
    const path = parsed.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    const bodyBuffer = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
    state.requests.push({
      method,
      url,
      ...(bodyBuffer.length && !request.headers['content-type']?.includes('multipart')
        ? { body: bodyBuffer.toString('utf8') }
        : {}),
    });

    if (state.token) {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${state.token}`) {
        sendJson(response, 401, { error: { message: 'unauthorized' } });
        return;
      }
    }

    if (method === 'GET' && path === '/system_stats') {
      sendJson(response, 200, {
        system: {
          os: 'posix',
          ram_total: 16 * 1024 * 1024 * 1024,
          ram_free: 8 * 1024 * 1024 * 1024,
          comfyui_version: '0.3.99-mock',
          python_version: '3.12.0 (mock)',
          argv: ['main.py'],
        },
        devices: [],
      });
      return;
    }

    if (method === 'GET' && path === '/features') {
      sendJson(response, 200, { supports_preview_metadata: true, mock: true });
      return;
    }

    if (method === 'GET' && path === '/object_info') {
      sendJson(response, 200, objectInfo);
      return;
    }

    if (method === 'GET' && path === '/userdata') {
      const items = Object.keys(workflows).map((workflowPath) => {
        const content = JSON.stringify(workflows[workflowPath]);
        return {
          path: workflowPath,
          type: 'file',
          modified: 1_750_000_000,
          size: Buffer.byteLength(content),
        };
      });
      sendJson(response, 200, items);
      return;
    }

    if (method === 'GET' && path === '/templates/index.json') {
      sendJson(response, 200, templateIndex);
      return;
    }

    if (method === 'GET' && path.startsWith('/templates/') && path.endsWith('.json')) {
      const name = decodeURIComponent(path.slice('/templates/'.length, -'.json'.length));
      const template = templates[name];
      if (template === undefined) {
        sendJson(response, 404, { error: { message: 'template not found' } });
        return;
      }
      sendJson(response, 200, template);
      return;
    }

    if (method === 'GET' && path.startsWith('/userdata/')) {
      const workflowPath = decodeURIComponent(path.slice('/userdata/'.length));
      const workflow = workflows[workflowPath];
      if (workflow === undefined) {
        sendJson(response, 404, { error: { message: 'workflow not found' } });
        return;
      }
      sendJson(response, 200, { content: JSON.stringify(workflow) });
      return;
    }

    if (method === 'POST' && path === '/prompt') {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(bodyBuffer.toString('utf8')) as Record<string, unknown>;
      } catch {
        sendJson(response, 400, { error: { message: 'invalid json' } });
        return;
      }
      const prompt = payload.prompt as Record<string, unknown> | undefined;
      if (!prompt || typeof prompt !== 'object') {
        sendJson(response, 400, { error: { message: 'prompt is required' } });
        return;
      }
      for (const [nodeId, rawNode] of Object.entries(prompt)) {
        if (!rawNode || typeof rawNode !== 'object') continue;
        const node = rawNode as { class_type?: string; inputs?: Record<string, unknown> };
        if (!node.class_type || !objectInfo[node.class_type]) {
          sendJson(response, 400, {
            error: { message: `unknown node type ${node.class_type ?? ''}` },
            node_errors: {
              [nodeId]: {
                class_type: node.class_type,
                errors: [{ type: 'invalid_node', message: 'node type not installed' }],
              },
            },
          });
          return;
        }
        if (node.class_type === 'CLIPTextEncode' && node.inputs?.text === 'TRIGGER_ERROR') {
          sendJson(response, 400, {
            error: {
              type: 'prompt_outputs_failed_validation',
              message: 'Prompt outputs failed validation',
            },
            node_errors: {
              [nodeId]: {
                class_type: node.class_type,
                errors: [
                  {
                    type: 'value_not_in_list',
                    message: 'mock rejection for TRIGGER_ERROR',
                    details: 'prompt text must not be TRIGGER_ERROR',
                  },
                ],
              },
            },
          });
          return;
        }
        if (node.class_type === 'KSampler' && node.inputs?.seed === 13) {
          sendJson(response, 400, {
            error: { type: 'prompt_outputs_failed_validation', message: 'bad seed' },
            node_errors: {
              [nodeId]: {
                class_type: node.class_type,
                errors: [{ type: 'invalid_input', message: 'seed 13 is not allowed in mock' }],
              },
            },
          });
          return;
        }
      }
      const id = randomUUID();
      const job = enqueue(id, prompt, typeof payload.client_id === 'string' ? payload.client_id : undefined);
      sendJson(response, 200, { prompt_id: id, number: job.number, node_errors: {} });
      return;
    }

    if (method === 'GET' && path === '/queue') {
      const queueEntry = (job: MockJob): unknown[] => [
        job.number,
        job.id,
        job.prompt,
        { client_id: job.clientId ?? '' },
        [],
      ];
      sendJson(response, 200, {
        queue_running: state.running ? [queueEntry(state.running)] : [],
        queue_pending: state.pending.map(queueEntry),
      });
      return;
    }

    if (method === 'POST' && path === '/queue') {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(bodyBuffer.toString('utf8')) as Record<string, unknown>;
      } catch {
        // ignore
      }
      const ids = Array.isArray(payload.delete) ? payload.delete : [];
      let deleted = 0;
      for (const id of ids) {
        if (typeof id === 'string' && cancelJob(id)) deleted += 1;
      }
      sendJson(response, 200, { deleted });
      return;
    }

    if (method === 'POST' && path === '/interrupt') {
      let canceled = false;
      if (state.running) canceled = cancelJob(state.running.id);
      sendJson(response, 200, { canceled });
      return;
    }

    if (method === 'POST' && path.startsWith('/jobs/')) {
      const id = parseJobIndex(path);
      if (id) {
        const canceled = cancelJob(id);
        if (path.endsWith('/status')) {
          const job = state.prompts.get(id);
          sendJson(response, 200, { status: job?.state ?? 'unknown' });
        } else if (!canceled && !state.prompts.has(id)) {
          sendJson(response, 404, { error: { message: 'job not found' } });
        } else {
          sendJson(response, 200, { canceled });
        }
        return;
      }
    }

    if (method === 'GET' && path === '/jobs') {
      sendJson(response, 200, {
        jobs: [...state.prompts.values()].map((job) => ({
          id: job.id,
          status: job.state,
        })),
      });
      return;
    }

    if (method === 'GET' && path.startsWith('/history_v2')) {
      const promptId = parsed.searchParams.get('prompt_id');
      const entries = [...state.history.entries()].map(([id, entry]) => ({
        ...(entry as Record<string, unknown>),
        prompt_id: id,
      }));
      const filtered = promptId ? entries.filter((entry) => entry.prompt_id === promptId) : entries;
      sendJson(response, 200, { history: filtered });
      return;
    }

    if (method === 'GET' && path.startsWith('/history/')) {
      const promptId = decodeURIComponent(path.slice('/history/'.length));
      const entry = state.history.get(promptId);
      sendJson(response, 200, entry ? { [promptId]: entry } : {});
      return;
    }

    if (method === 'POST' && path === '/upload/image') {
      const contentType = request.headers['content-type'] ?? '';
      const file = parseMultipartFile(bodyBuffer, contentType);
      if (!file) {
        sendJson(response, 400, { error: { message: 'missing image field' } });
        return;
      }
      if (!file.contentType.startsWith('image/')) {
        sendJson(response, 415, { error: { message: 'only images are accepted' } });
        return;
      }
      const name = sanitizeFilename(file.filename);
      state.uploads.set(name, file);
      const hash = createHash('sha256').update(file.data).digest('hex').slice(0, 16);
      sendJson(response, 200, {
        name,
        subfolder: '',
        type: 'input',
        asset_hash: `blake3:mock-${hash}`,
      });
      return;
    }

    if (method === 'GET' && path === '/view') {
      const filename = parsed.searchParams.get('filename') ?? '';
      const file = state.outputFiles.get(filename) ?? state.uploads.get(filename);
      if (!file) {
        sendJson(response, 404, { error: { message: 'file not found' } });
        return;
      }
      const range = request.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Math.min(Number(match[2]), file.data.length - 1) : file.data.length - 1;
          if (start > end || start >= file.data.length) {
            response.writeHead(416, { 'content-range': `bytes */${file.data.length}` });
            response.end();
            return;
          }
          const chunk = file.data.subarray(start, end + 1);
          response.writeHead(206, {
            'content-type': file.contentType,
            'content-length': chunk.length,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${file.data.length}`,
          });
          response.end(chunk);
          return;
        }
      }
      response.writeHead(200, {
        'content-type': file.contentType,
        'content-length': file.data.length,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      response.end(file.data);
      return;
    }

    if (method === 'GET' && path === '/') {
      sendText(response, 200, 'ComfyUI mock server');
      return;
    }

    sendJson(response, 404, { error: { message: `mock route not found: ${method} ${path}` } });
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://mock.local').pathname;
    if (pathname.replace(/\/+$/, '') !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    state.clients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'status',
        data: {
          status: { exec_info: { queue_remaining: queueRemaining() } },
          sid: 'mock',
        },
      }),
    );
    ws.on('close', () => state.clients.delete(ws));
    ws.on('error', () => state.clients.delete(ws));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = options.host && options.host !== '0.0.0.0' && options.host !== '::'
    ? options.host
    : '127.0.0.1';
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;

  return {
    url,
    port: address.port,
    state,
    broadcast,
    emitProgress,
    close: async () => {
      for (const timer of allTimers) clearTimeout(timer);
      allTimers.clear();
      for (const job of state.prompts.values()) {
        for (const timer of job.timers) clearTimeout(timer);
        job.timers.clear();
      }
      for (const client of state.clients) client.terminate();
      state.clients.clear();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        setTimeout(resolve, 500).unref?.();
      });
    },
  };
}
