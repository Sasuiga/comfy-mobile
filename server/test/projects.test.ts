import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT,
  buildProjectFolderName,
  parseProjectFolderName,
  projectDisplayTitle,
  type AssetEntry,
  type ProjectListResponse,
  type ProjectSummary,
  type RunRecord,
  type WorkflowDetail,
  type WorkflowSummary,
} from '@comfy-mobile/shared';
import { buildApp } from '../src/app.js';
import { createMockComfyServer, type MockComfyServer } from '../src/mock/server.js';
import { MOCK_THUMBNAIL_PNG } from '../src/mock/fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
const PNG = Buffer.from(MOCK_THUMBNAIL_PNG, 'base64');

afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function startApp(
  mockUrl: string,
  prepareRoot?: (assetRoot: string) => Promise<void>,
): Promise<{ app: FastifyInstance; assetRoot: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comfy-mobile-projects-data-'));
  const assetRoot = await mkdtemp(join(tmpdir(), 'comfy-mobile-projects-root-'));
  if (prepareRoot) await prepareRoot(assetRoot);
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
  return { app: built.app, assetRoot };
}

async function startMock(): Promise<MockComfyServer> {
  const mock = await createMockComfyServer({ stepDelayMs: 5 });
  cleanups.push(() => mock.close());
  return mock;
}

function multipart(boundary: string, filename: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: image/png\r\n\r\n',
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function uploadAsset(
  app: FastifyInstance,
  path: string,
  filename = 'photo.png',
): Promise<AssetEntry> {
  const boundary = '----comfy-mobile-projects-test';
  const response = await app.inject({
    method: 'POST',
    url: `/api/assets/upload?path=${encodeURIComponent(path)}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, filename, PNG),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().item as AssetEntry;
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

async function listProjects(app: FastifyInstance): Promise<ProjectListResponse> {
  const response = await app.inject({ method: 'GET', url: '/api/projects' });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ProjectListResponse;
}

describe('project folder names', () => {
  it('uses an Avalon-style date prefix and parses it back', () => {
    expect(buildProjectFolderName('秋季海报', new Date(2026, 9, 23))).toBe(
      '20261023-秋季海报',
    );
    expect(parseProjectFolderName('20261023-秋季海报')).toEqual({
      title: '秋季海报',
      createdDate: '2026-10-23',
    });
    expect(projectDisplayTitle('20261023-秋季海报')).toBe('秋季海报');
    expect(parseProjectFolderName('旧项目')).toEqual({ title: '旧项目' });
    expect(projectDisplayTitle(DEFAULT_PROJECT)).toBe(DEFAULT_PROJECT);
  });
});

describe('projects', () => {
  it('migrates legacy root inputs/outputs into the default project', async () => {
    const mock = await startMock();
    const { app, assetRoot } = await startApp(mock.url, async (root) => {
      // The pre-project layout kept inputs/outputs directly under ComfyMobile.
      const workspace = join(root, 'ComfyMobile');
      await mkdir(join(workspace, 'inputs'), { recursive: true });
      await mkdir(join(workspace, 'outputs', '2025', '01'), { recursive: true });
      await writeFile(join(workspace, 'inputs', 'legacy.png'), PNG);
      await writeFile(join(workspace, 'outputs', '2025', '01', 'old.png'), PNG);
    });

    const projects = await listProjects(app);
    const legacy = projects.items.find((item) => item.path === DEFAULT_PROJECT);
    expect(legacy).toBeTruthy();
    expect(legacy?.inputCount).toBe(1);
    expect(legacy?.outputCount).toBe(1);
    expect(legacy?.cover).toBe(`${DEFAULT_PROJECT}/outputs/2025/01/old.png`);

    // Old, project-less paths keep resolving after migration.
    const oldPath = await app.inject({
      method: 'GET',
      url: '/api/assets/file?path=inputs%2Flegacy.png',
    });
    expect(oldPath.statusCode).toBe(200);

    const moved = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(`${DEFAULT_PROJECT}/inputs/legacy.png`)}`,
    });
    expect(moved.statusCode).toBe(200);

    await expect(access(join(assetRoot, 'ComfyMobile', 'inputs'))).rejects.toThrow();
    const rootInputs = await app.inject({ method: 'GET', url: '/api/assets/list?path=' });
    expect(
      (rootInputs.json().dirs as Array<{ name: string }>).some(
        (dir: { name: string }) => dir.name === 'inputs',
      ),
    ).toBe(false);

    // Root-level inputs are reserved for legacy migration only.
    const legacyListing = await app.inject({
      method: 'GET',
      url: `/api/assets/list?path=${encodeURIComponent(DEFAULT_PROJECT + '/inputs')}`,
    });
    expect(legacyListing.statusCode).toBe(200);
    expect(
      (legacyListing.json().files as AssetEntry[]).map((file) => file.name),
    ).toEqual(['legacy.png']);
  });

  it('creates, lists, details and directly deletes projects', async () => {
    const mock = await startMock();
    const { app } = await startApp(mock.url);
    const folderA = buildProjectFolderName('项目A');
    expect(folderA).toMatch(/^\d{8}-项目A$/);

    const initial = await listProjects(app);
    expect(initial.items.map((item) => item.path)).toEqual([DEFAULT_PROJECT]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '项目A' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const project = created.json().item as ProjectSummary;
    expect(project.path).toBe(folderA);
    expect(project.name).toBe(folderA);
    expect(project.title).toBe('项目A');
    expect(project.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(project.inputCount).toBe(0);
    expect(project.outputCount).toBe(0);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '项目A' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('PROJECT_EXISTS');

    for (const name of ['inputs', 'outputs', '../escape', '.hidden', 'a/b']) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name },
      });
      expect(invalid.statusCode, `${name}: ${invalid.body}`).toBe(400);
      expect(invalid.json().error.code).toBe('INVALID_PROJECT_NAME');
    }

    const detail = await app.inject({
      method: 'GET',
      url: `/api/projects/detail?path=${encodeURIComponent(folderA)}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json().item as ProjectSummary).title).toBe('项目A');

    const item = await uploadAsset(app, `${folderA}/inputs`);
    expect(item.path).toBe(`${folderA}/inputs/photo.png`);

    const withAsset = await listProjects(app);
    const listed = withAsset.items.find((entry) => entry.path === folderA);
    expect(listed?.inputCount).toBe(1);
    expect(listed?.title).toBe('项目A');

    const protectedDefault = await app.inject({
      method: 'DELETE',
      url: `/api/projects?path=${encodeURIComponent(DEFAULT_PROJECT)}`,
    });
    expect(protectedDefault.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/projects?path=${encodeURIComponent('不存在的项目')}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('PROJECT_NOT_FOUND');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/projects?path=${encodeURIComponent(folderA)}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/api/projects/detail?path=${encodeURIComponent(folderA)}`,
    });
    expect(afterDelete.statusCode).toBe(404);

    const deletedAsset = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(item.path)}`,
    });
    expect(deletedAsset.statusCode).toBe(404);

    expect((await listProjects(app)).items.map((entry) => entry.path)).toEqual([
      DEFAULT_PROJECT,
    ]);
  });

  it('archives runs into their project and filters history by project', async () => {
    const mock = await startMock();
    const { app } = await startApp(mock.url);

    const folderB = buildProjectFolderName('项目B');
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '项目B' } });
    const item = await uploadAsset(app, `${folderB}/inputs`);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/workflows/import',
      payload: {
        name: 'project-input',
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
    const detail = detailResponse.json() as WorkflowDetail;
    const imageField = detail.fields.find((field) => field.kind === 'image');
    expect(imageField).toBeTruthy();

    const submit = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        workflowKey: summary.key,
        project: folderB,
        values: {
          [imageField!.key]: { path: item.path, name: item.name, kind: item.kind },
        },
      },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    const submitted = submit.json() as { runId: string };

    const run = await waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/runs/${submitted.runId}`,
      });
      if (response.statusCode !== 200) return undefined;
      const record = response.json() as RunRecord;
      if (record.state === 'failed') throw new Error(JSON.stringify(record.error));
      return record.state === 'completed' ? record : undefined;
    });

    expect(run.project).toBe(folderB);
    const output = run.outputs[0]!;
    expect(output.archiveError).toBeUndefined();
    expect(output.assetPath).toMatch(
      new RegExp(`^${folderB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/outputs\\/\\d{4}\\/\\d{2}\\/`),
    );

    const projectRuns = await app.inject({
      method: 'GET',
      url: `/api/runs?project=${encodeURIComponent(folderB)}`,
    });
    expect(
      (projectRuns.json().items as Array<{ id: string; project?: string }>).map(
        (entry) => entry.id,
      ),
    ).toContain(run.id);

    const defaultRuns = await app.inject({
      method: 'GET',
      url: `/api/runs?project=${encodeURIComponent(DEFAULT_PROJECT)}`,
    });
    expect(
      (defaultRuns.json().items as Array<{ id: string }>).some(
        (entry) => entry.id === run.id,
      ),
    ).toBe(false);

    const projects = await listProjects(app);
    const listed = projects.items.find((entry) => entry.path === folderB);
    expect(listed?.outputCount).toBe(1);
    expect(listed?.cover).toBe(output.assetPath);

    // Deleting the project removes files but keeps history.
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/projects?path=${encodeURIComponent(folderB)}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const stillThere = await app.inject({
      method: 'GET',
      url: `/api/runs/${run.id}`,
    });
    expect(stillThere.statusCode).toBe(200);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/assets/file?path=${encodeURIComponent(output.assetPath!)}`,
    });
    expect(gone.statusCode).toBe(404);
  });
});
