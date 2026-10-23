import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AssetEntry,
  AssetListResponse,
  AssetStorageInfo,
  RunRecord,
  WorkflowDetail,
  WorkflowSummary,
} from '@comfy-mobile/shared';
import { buildApp } from '../src/app.js';
import { createMockComfyServer, type MockComfyServer } from '../src/mock/server.js';
import { MOCK_THUMBNAIL_PNG } from '../src/mock/fixtures.js';

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
  dataDir: string;
  assetRoot: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-mobile-assets-data-'));
  const assetRoot = await mkdtemp(join(tmpdir(), 'comfy-mobile-assets-root-'));
  const built = await buildApp({
    logger: false,
    dataDir,
    webDist: join(dataDir, 'no-web'),
    env: {
      PORT: '3000',
      DATA_DIR: dataDir,
      WEB_DIST: join(dataDir, 'no-web'),
      COMFYUI_URL: mockUrl,
      ASSET_ROOT: assetRoot,
      ...extraEnv,
    },
    background: false,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  await built.startBackground();
  cleanups.push(async () => {
    await built.app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(assetRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { app: built.app, dataDir, assetRoot };
}

async function startMock(): Promise<MockComfyServer> {
  const mock = await createMockComfyServer({ stepDelayMs: 5 });
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

const PNG = Buffer.from(MOCK_THUMBNAIL_PNG, 'base64');

async function uploadAsset(
  app: FastifyInstance,
  filename = 'photo.png',
  mime = 'image/png',
  data = PNG,
): Promise<AssetEntry> {
  const boundary = '----comfy-mobile-assets-test';
  const response = await app.inject({
    method: 'POST',
    url: '/api/assets/upload?path=inputs',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, filename, mime, data),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().item as AssetEntry;
}

describe('asset workspace', () => {
  it('reports storage, streams uploads, serves ranges and deletes files', async () => {
    const mock = await startMock();
    const { app, assetRoot } = await startApp(mock.url);

    const infoResponse = await app.inject({ method: 'GET', url: '/api/assets/info' });
    expect(infoResponse.statusCode).toBe(200);
    const info = infoResponse.json() as AssetStorageInfo;
    expect(info.fallback).toBe(false);
    expect(info.workspace).toBe('ComfyMobile');
    expect(info.browseRoot).toBe(await realpath(assetRoot));
    expect(info.workspacePath).toBe(join(await realpath(assetRoot), 'ComfyMobile'));

    const item = await uploadAsset(app);
    expect(item).toMatchObject({ name: 'photo.png', path: '默认项目/inputs/photo.png', kind: 'image' });
    expect((await app.inject({
      method: 'GET',
      url: '/api/assets/file?path=inputs%2Fphoto.png',
    })).statusCode).toBe(200);
    expect(item.size).toBe(PNG.length);

    const duplicate = await uploadAsset(app);
    expect(duplicate.path).not.toBe(item.path);
    expect(duplicate.name).toMatch(/^photo.*\.png$/);

    const listResponse = await app.inject({ method: 'GET', url: '/api/assets/list?path=inputs' });
    expect(listResponse.statusCode).toBe(200);
    const listing = listResponse.json() as AssetListResponse;
    expect(listing.files.some((file) => file.path === item.path)).toBe(true);
    expect(listing.dirs).toEqual([]);

    const fileResponse = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(item.path)}`,
    });
    expect(fileResponse.statusCode).toBe(200);
    expect(fileResponse.headers['content-type']).toContain('image/png');
    expect(fileResponse.headers['accept-ranges']).toBe('bytes');
    expect(fileResponse.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const rangeResponse = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(item.path)}`,
      headers: { range: 'bytes=0-9' },
    });
    expect(rangeResponse.statusCode).toBe(206);
    expect(rangeResponse.headers['content-range']).toBe(`bytes 0-9/${PNG.length}`);

    const downloadResponse = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(item.path)}&download=1`,
    });
    expect(downloadResponse.headers['content-disposition']).toContain('attachment');

    const traversal = await app.inject({
      method: 'GET',
      url: '/api/assets/file?path=../outside.png',
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe('INVALID_ASSET_PATH');

    const listTraversal = await app.inject({
      method: 'GET',
      url: '/api/assets/list?path=inputs%2F..%2F..',
    });
    expect(listTraversal.statusCode).toBe(400);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/assets/file?path=${encodeURIComponent(item.path)}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    const missing = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(item.path)}`,
    });
    expect(missing.statusCode).toBe(404);

    const rootDelete = await app.inject({ method: 'DELETE', url: '/api/assets/file?path=' });
    expect(rootDelete.statusCode).toBe(400);

    const boundary = '----comfy-mobile-assets-bad';
    const badType = await app.inject({
      method: 'POST',
      url: '/api/assets/upload?path=inputs',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, 'notes.txt', 'text/plain', Buffer.from('hello')),
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().error.code).toBe('INVALID_FILE_TYPE');
  });

  it('browses directories under the root and switches the workspace', async () => {
    const mock = await startMock();
    const { app, assetRoot } = await startApp(mock.url);
    await mkdir(join(assetRoot, 'Photos'), { recursive: true });
    await mkdir(join(assetRoot, 'Photos', 'Comfy'), { recursive: true });

    const browse = await app.inject({ method: 'GET', url: '/api/assets/browse?path=' });
    expect(browse.statusCode).toBe(200);
    const rootListing = browse.json() as { dirs: Array<{ name: string; path: string }> };
    expect(rootListing.dirs.map((dir) => dir.name)).toContain('Photos');

    const nested = await app.inject({ method: 'GET', url: '/api/assets/browse?path=Photos' });
    expect((nested.json().dirs as Array<{ path: string }>).map((dir) => dir.path)).toContain(
      'Photos/Comfy',
    );

    const select = await app.inject({
      method: 'POST',
      url: '/api/assets/select',
      payload: { path: 'Photos/Comfy' },
    });
    expect(select.statusCode, select.body).toBe(200);
    const info = select.json() as AssetStorageInfo;
    expect(info.workspace).toBe('Photos/Comfy');
    expect(info.workspacePath).toBe(join(await realpath(assetRoot), 'Photos', 'Comfy'));

    const after = await app.inject({ method: 'GET', url: '/api/assets/info' });
    expect((after.json() as AssetStorageInfo).workspace).toBe('Photos/Comfy');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/assets/select',
      payload: { path: '../escape' },
    });
    expect(invalid.statusCode).toBe(400);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/assets/select',
      payload: { path: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('uploads workspace assets to ComfyUI and archives run outputs', async () => {
    const mock = await startMock();
    const { app } = await startApp(mock.url);
    const item = await uploadAsset(app);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/workflows/import',
      payload: {
        name: 'asset-input',
        workflow: {
          '10': {
            class_type: 'LoadImage',
            inputs: { image: 'example.png' },
            _meta: { title: 'Input Image' },
          },
          '11': {
            class_type: 'SaveImage',
            inputs: { images: ['10', 0], filename_prefix: 'ComfyUI' },
          },
        },
      },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const summary = imported.json().item as WorkflowSummary;

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/workflows/${encodeURIComponent(summary.key)}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as WorkflowDetail;
    const imageField = detail.fields.find((field) => field.kind === 'image');
    expect(imageField).toBeTruthy();

    const submit = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        workflowKey: summary.key,
        values: {
          [imageField!.key]: { path: item.path, name: item.name, kind: item.kind },
        },
      },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    const submitted = submit.json() as { runId: string; promptId: string };

    const run = await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: `/api/runs/${submitted.runId}` });
      if (response.statusCode !== 200) return undefined;
      const record = response.json() as RunRecord;
      if (record.state === 'failed') throw new Error(JSON.stringify(record.error));
      return record.state === 'completed' ? record : undefined;
    });

    expect(mock.state.requests.some((request) => request.url.startsWith('/api/upload/image'))).toBe(
      true,
    );
    const uploaded = mock.state.uploads.get(item.name);
    expect(uploaded).toBeTruthy();

    const job = mock.state.prompts.get(submitted.promptId);
    expect(job).toBeTruthy();
    const promptImage = (job!.prompt['10'] as { inputs: { image: string } }).inputs.image;
    expect(promptImage).toMatch(/^blake3:mock-/);

    expect(run.outputs).toHaveLength(1);
    const output = run.outputs[0]!;
    expect(output.archiveError).toBeUndefined();
    expect(output.assetPath).toMatch(/^默认项目\/outputs\/\d{4}\/\d{2}\//);

    const archived = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(output.assetPath!)}`,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    const history = await app.inject({ method: 'GET', url: '/api/runs?limit=5' });
    const first = (history.json().items as Array<{ thumbnail?: string }>)[0];
    expect(first?.thumbnail).toContain('/api/assets/file');
  });
});
