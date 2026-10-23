import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowDetail, WorkflowSummary } from '@comfy-mobile/shared';
import { buildApp } from '../src/app.js';
import { createMockComfyServer, type MockComfyServer } from '../src/mock/server.js';
import { MOCK_THUMBNAIL_PNG, mockApiWorkflow } from '../src/mock/fixtures.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function startApp(
  mockUrl: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{
  app: FastifyInstance;
  baseUrl: string;
  dataDir: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-mobile-test-'));
  const built = await buildApp({
    logger: false,
    dataDir,
    webDist: join(dataDir, 'no-web'),
    env: {
      PORT: '3000',
      DATA_DIR: dataDir,
      WEB_DIST: join(dataDir, 'no-web'),
      COMFYUI_URL: mockUrl,
      ...extraEnv,
    },
    background: false,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  await built.startBackground();
  const address = built.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  cleanups.push(async () => {
    await built.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app: built.app, baseUrl: `http://127.0.0.1:${port}`, dataDir };
}

async function startMock(options: Parameters<typeof createMockComfyServer>[0] = {}): Promise<MockComfyServer> {
  const mock = await createMockComfyServer({ stepDelayMs: 5, ...options });
  cleanups.push(() => mock.close());
  return mock;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined | null>,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

function multipart(boundary: string, filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('API integration with mock ComfyUI', () => {
  it('runs the full list → detail → run → output → history flow', async () => {
    const mock = await startMock();
    const { app, baseUrl } = await startApp(mock.url);

    const config = await app.inject({ method: 'GET', url: '/api/config' });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ comfyUrl: mock.url, setupRequired: false });

    const listResponse = await app.inject({ method: 'GET', url: '/api/workflows?refresh=1' });
    expect(listResponse.statusCode).toBe(200);
    const items = listResponse.json().items as WorkflowSummary[];
    expect(items.map((item) => item.name).sort()).toEqual(['txt2img-api', 'txt2img-ui']);
    const uiWorkflow = items.find((item) => item.name === 'txt2img-ui');
    expect(uiWorkflow?.format).toBe('ui');
    expect(uiWorkflow?.hasAppConfig).toBe(true);

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/workflows/${encodeURIComponent(uiWorkflow!.key)}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as WorkflowDetail;
    expect(detail.format).toBe('ui');
    expect(detail.fields.filter((field) => field.visible)).toHaveLength(8);
    expect(detail.fields.find((field) => field.key === '2.text')?.label).toBe('正向提示词');

    const submitResponse = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        workflowKey: uiWorkflow!.key,
        values: { '2.text': 'a red fox', '5.seed': 7, '5.steps': 12 },
      },
    });
    expect(submitResponse.statusCode).toBe(200);
    const submitted = submitResponse.json() as {
      runId: string;
      promptId: string;
      resolvedSeeds: Record<string, number>;
    };
    expect(submitted.runId).toBeTruthy();
    expect(submitted.resolvedSeeds['5.seed']).toBe(7);

    const completed = await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${submitted.runId}` });
      if (response.statusCode !== 200) return undefined;
      const run = response.json() as { state: string; outputs: unknown[] };
      return run.state === 'completed' ? run : run.state === 'failed' ? run : undefined;
    });
    expect(completed.state).toBe('completed');
    expect(completed.outputs).toHaveLength(1);
    const output = (completed.outputs as Array<{ key: string; kind: string }>)[0]!;
    expect(output.kind).toBe('image');

    const outputResponse = await app.inject({
      method: 'GET',
      url: `/api/outputs/${submitted.runId}/${output.key}?thumb=1`,
    });
    expect(outputResponse.statusCode).toBe(200);
    expect(outputResponse.headers['content-type']).toContain('image/png');
    expect(outputResponse.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const rangeResponse = await app.inject({
      method: 'GET',
      url: `/api/outputs/${submitted.runId}/${output.key}`,
      headers: { range: 'bytes=0-9' },
    });
    expect(rangeResponse.statusCode).toBe(206);
    expect(rangeResponse.headers['content-range']).toMatch(/^bytes 0-9\//);

    const historyResponse = await app.inject({ method: 'GET', url: '/api/runs?limit=10' });
    const history = historyResponse.json().items as Array<{ id: string; thumbnail?: string }>;
    expect(history[0]?.id).toBe(submitted.runId);
    expect(history[0]?.thumbnail).toContain('/api/outputs/');

    const sseResponse = await fetch(`${baseUrl}/api/runs/${submitted.runId}/events`);
    expect(sseResponse.status).toBe(200);
    const sseText = await sseResponse.text();
    expect(sseText).toContain('event: snapshot');
    expect(sseText).toContain('event: done');

    expect(mock.state.requests.some((request) => request.url.startsWith('/api/prompt'))).toBe(true);
  });

  it('validates form overrides, presets, imports and uploads', async () => {
    const mock = await startMock();
    const { app } = await startApp(mock.url);
    const listResponse = await app.inject({ method: 'GET', url: '/api/workflows?refresh=1' });
    const items = listResponse.json().items as WorkflowSummary[];
    const key = items.find((item) => item.name === 'txt2img-ui')!.key;

    const overrideResponse = await app.inject({
      method: 'PUT',
      url: `/api/workflows/${encodeURIComponent(key)}/fields`,
      payload: {
        fields: [
          { key: '5.steps', label: '采样步数', kind: 'slider', visible: true, order: 0 },
          { key: '9.removed', label: '旧字段' },
        ],
      },
    });
    expect(overrideResponse.statusCode).toBe(200);
    const overridden = overrideResponse.json() as WorkflowDetail;
    expect(overridden.fields.find((field) => field.key === '5.steps')?.label).toBe('采样步数');
    expect(overridden.staleOverrides).toContain('9.removed');

    const resetResponse = await app.inject({
      method: 'DELETE',
      url: `/api/workflows/${encodeURIComponent(key)}/fields`,
    });
    expect(resetResponse.statusCode).toBe(200);
    expect((resetResponse.json() as WorkflowDetail).staleOverrides).toEqual([]);

    const presetResponse = await app.inject({
      method: 'POST',
      url: `/api/workflows/${encodeURIComponent(key)}/presets`,
      payload: { name: '夜景', values: { '5.seed': 12, '2.text': 'night' } },
    });
    expect(presetResponse.statusCode).toBe(200);
    const preset = presetResponse.json().preset as { id: string };
    const presets = await app.inject({
      method: 'GET',
      url: `/api/workflows/${encodeURIComponent(key)}/presets`,
    });
    expect((presets.json().presets as unknown[]).length).toBe(1);
    await app.inject({
      method: 'DELETE',
      url: `/api/workflows/${encodeURIComponent(key)}/presets/${preset.id}`,
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/workflows/${encodeURIComponent(key)}/presets`,
        })
      ).json().presets,
    ).toEqual([]);

    const boundary = '----comfy-mobile-test';
    const uploadResponse = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(
        boundary,
        'input.png',
        'image/png',
        Buffer.from(MOCK_THUMBNAIL_PNG, 'base64'),
      ),
    });
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(200);
    expect(uploadResponse.json()).toMatchObject({
      name: 'input.png',
      type: 'input',
    });
    expect(uploadResponse.json().assetHash).toMatch(/^blake3:mock-/);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/workflows/import',
      payload: {
        name: '我的工作流',
        workflow: mockApiWorkflow,
      },
    });
    expect(imported.statusCode).toBe(200);
    expect((imported.json().item as WorkflowSummary).source).toBe('imported');
  });

  it('rejects unknown fields and surfaces ComfyUI node errors', async () => {
    const mock = await startMock();
    const { app } = await startApp(mock.url);
    const items = (
      await app.inject({ method: 'GET', url: '/api/workflows?refresh=1' })
    ).json().items as WorkflowSummary[];
    const key = items.find((item) => item.name === 'txt2img-ui')!.key;

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workflowKey: key, values: { 'nope.field': 1 } },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('UNKNOWN_FIELD');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { workflowKey: key, values: { '2.text': 'TRIGGER_ERROR' } },
    });
    expect(rejected.statusCode).toBe(422);
    const body = rejected.json();
    expect(body.error.code).toBe('NODE_ERRORS');
    expect(body.error.details.nodeErrors[0]).toMatchObject({
      nodeId: '2',
      fieldKey: '2.text',
    });
  });

  it('cancels queued runs and does not cancel finished runs', async () => {
    const mock = await startMock({ autoRun: false });
    const { app } = await startApp(mock.url);
    const items = (
      await app.inject({ method: 'GET', url: '/api/workflows?refresh=1' })
    ).json().items as WorkflowSummary[];
    const key = items.find((item) => item.name === 'txt2img-ui')!.key;

    const submitted = (
      await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { workflowKey: key, values: { '5.seed': 1 } },
      })
    ).json() as { runId: string };
    const canceled = await app.inject({
      method: 'POST',
      url: `/api/runs/${submitted.runId}/cancel`,
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().state).toBe('canceled');
  });

  it('enforces AUTH_TOKEN on API routes', async () => {
    const mock = await startMock();
    const { app } = await startApp(mock.url, { AUTH_TOKEN: 'secret-token' });

    const unauthorized = await app.inject({ method: 'GET', url: '/api/config' });
    expect(unauthorized.statusCode).toBe(401);

    const health = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(health.statusCode).toBe(200);

    const authorized = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(authorized.statusCode).toBe(200);
  });
});
