import type { WorkflowFormat, WorkflowSummary } from '@comfy-mobile/shared';
import type { ComfyClient, UserDataItem } from '../comfy/client.js';
import type { JsonStore } from '../store/jsonStore.js';
import { AppError, toErrorMessage } from '../errors.js';
import { decodeWorkflowKey, shortHash, validateRemoteWorkflowPath, workflowKey } from '../security.js';
import { detectFormat } from './convert.js';
import { parseLinearData } from './linear.js';
import { detectWorkflowMedia } from './media.js';

interface WorkflowCacheFile {
  fetchedAt: string;
  items: WorkflowSummary[];
}

export interface RawWorkflow {
  key: string;
  summary: WorkflowSummary;
  workflow: unknown;
}

const CACHE_PATH = 'cache/workflows.json';
const LIST_TTL_MS = 60_000;

function baseName(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.json$/i, '');
}

export class WorkflowRepository {
  private items: WorkflowSummary[] = [];
  private fetchedAt = 0;
  private allowedRemotePaths = new Set<string>();
  private loading?: Promise<WorkflowSummary[]>;

  constructor(
    private readonly store: JsonStore,
    private readonly client: ComfyClient,
  ) {}

  async load(): Promise<void> {
    const cached = await this.store.read<WorkflowCacheFile>(CACHE_PATH, {
      fetchedAt: '',
      items: [],
    });
    if (Array.isArray(cached.items)) {
      this.items = cached.items;
      this.fetchedAt = Date.parse(cached.fetchedAt) || 0;
    }
    for (const item of this.items) {
      if (item.source === 'remote') this.allowedRemotePaths.add(item.path);
    }
    // Imported workflows are local and always available.
    await this.refreshImported();
  }

  async list(force = false): Promise<WorkflowSummary[]> {
    const withinTtl = Date.now() - this.fetchedAt < LIST_TTL_MS;
    // Summaries cached by an older version have no media; refresh eagerly so
    // the picker can show image/video badges right after an upgrade.
    const missingMedia = this.items.some(
      (item) => item.source === 'remote' && item.media === undefined,
    );
    if (!force && withinTtl && !missingMedia) {
      return this.items;
    }
    if (this.loading) return this.loading;
    this.loading = this.fetchAndEnrich().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async fetchAndEnrich(): Promise<WorkflowSummary[]> {
    let remote: UserDataItem[] = [];
    let fetchError: unknown;
    try {
      remote = await this.client.listWorkflows();
    } catch (error) {
      fetchError = error;
    }

    if (fetchError && this.items.some((item) => item.source === 'remote')) {
      // Keep serving the last known list; connection status and the next
      // refresh will make the failure visible.
      await this.refreshImported();
      return this.items;
    }
    if (fetchError) throw fetchError;

    this.allowedRemotePaths = new Set(remote.map((item) => item.path));
    const cachedByPath = new Map(
      this.items.filter((item) => item.source === 'remote').map((item) => [item.path, item]),
    );
    const summaries: WorkflowSummary[] = remote.map((item) => ({
      key: workflowKey('remote', item.path),
      name: item.name || baseName(item.path),
      path: item.path,
      source: 'remote',
      mtime: item.modified,
      size: item.size,
      format: cachedByPath.get(item.path)?.format,
      media: cachedByPath.get(item.path)?.media,
      hasAppConfig: cachedByPath.get(item.path)?.hasAppConfig,
    }));

    // Older caches predate `media`, so re-read those workflows once to fill it.
    const pending = summaries.filter(
      (item) => item.format === undefined || item.media === undefined,
    );
    const concurrency = 5;
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < pending.length) {
        const current = pending[index];
        index += 1;
        if (!current) continue;
        try {
          const workflow = await this.client.readWorkflow(current.path, 15_000);
          const format = detectFormat(workflow) ?? undefined;
          current.format = format as WorkflowFormat | undefined;
          current.media = detectWorkflowMedia(workflow, `${current.name} ${current.path}`);
          current.hasAppConfig = Boolean(parseLinearData(workflow)?.inputs.length);
        } catch {
          // Listing remains usable even if one file is broken.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

    this.items = summaries.sort((a, b) =>
      a.path.localeCompare(b.path, 'zh-CN', { numeric: true }),
    );
    this.fetchedAt = Date.now();
    await this.persist();
    await this.refreshImported();
    return this.items;
  }

  private async refreshImported(): Promise<void> {
    const files = await this.store.list('imported');
    const imported: WorkflowSummary[] = [];
    for (const file of files) {
      if (!/\.json$/i.test(file)) continue;
      // Imported files may be UI-format (e.g. official templates) or API.
      let format: WorkflowSummary['format'] = 'api';
      let media: WorkflowSummary['media'];
      try {
        const workflow = await this.store.readOrNull<unknown>(`imported/${file}`);
        format = detectFormat(workflow) ?? 'api';
        media = detectWorkflowMedia(workflow, file);
      } catch {
        // Keep the file listed; loading it later will surface the error.
      }
      imported.push({
        key: workflowKey('imported', file),
        name: baseName(file),
        path: file,
        source: 'imported',
        format,
        media,
      });
    }
    const remote = this.items.filter((item) => item.source === 'remote');
    this.items = [...remote, ...imported].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'imported' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    });
  }

  private async persist(): Promise<void> {
    await this.store.write(CACHE_PATH, {
      fetchedAt: new Date(this.fetchedAt).toISOString(),
      items: this.items.filter((item) => item.source === 'remote'),
    } satisfies WorkflowCacheFile);
  }

  async getRaw(key: string): Promise<RawWorkflow> {
    const decoded = decodeWorkflowKey(key);
    if (decoded.source === 'imported') {
      const storedPath = `imported/${decoded.path}`;
      const workflow = await this.store.readOrNull<unknown>(storedPath);
      if (workflow === null) {
        throw new AppError(404, 'WORKFLOW_NOT_FOUND', '导入的工作流不存在');
      }
      return {
        key,
        summary: {
          key,
          name: baseName(decoded.path),
          path: decoded.path,
          source: 'imported',
          format: detectFormat(workflow) ?? 'api',
          media: detectWorkflowMedia(workflow, decoded.path),
        },
        workflow,
      };
    }

    const path = validateRemoteWorkflowPath(decoded.path);
    if (!this.allowedRemotePaths.has(path)) {
      try {
        await this.list(true);
      } catch {
        // The error below is clearer than a connection error for direct links.
      }
    }
    if (!this.allowedRemotePaths.has(path)) {
      throw new AppError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在，请刷新工作流列表');
    }
    try {
      const workflow = await this.client.readWorkflow(path);
      const cached = this.items.find((item) => item.source === 'remote' && item.path === path);
      const format = detectFormat(workflow) ?? undefined;
      return {
        key,
        summary: {
          key,
          name: cached?.name ?? baseName(path),
          path,
          source: 'remote',
          mtime: cached?.mtime,
          size: cached?.size,
          format: format as WorkflowFormat | undefined,
          media:
            cached?.media ?? detectWorkflowMedia(workflow, `${cached?.name ?? baseName(path)} ${path}`),
          hasAppConfig: Boolean(parseLinearData(workflow)?.inputs.length),
        },
        workflow,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'WORKFLOW_READ_FAILED', `读取工作流失败：${toErrorMessage(error)}`);
    }
  }

  async importWorkflow(name: string | undefined, workflow: unknown): Promise<WorkflowSummary> {
    const format = detectFormat(workflow);
    if (!format) {
      throw new AppError(
        400,
        'INVALID_WORKFLOW',
        '无法识别工作流格式，请选择 ComfyUI 保存的 UI 格式或导出的 API 格式 JSON',
      );
    }
    const rawName = (name || 'imported-workflow').trim() || 'imported-workflow';
    const slug =
      rawName
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'workflow';
    const hash = shortHash(JSON.stringify(workflow), 8);
    const file = `${slug}-${hash}.json`;
    await this.store.write(`imported/${file}`, workflow);
    await this.refreshImported();
    return this.items.find((item) => item.source === 'imported' && item.path === file)!;
  }

  async deleteImported(key: string): Promise<void> {
    const decoded = decodeWorkflowKey(key);
    if (decoded.source !== 'imported') {
      throw new AppError(400, 'NOT_IMPORTED', '只能删除导入的工作流');
    }
    await this.store.remove(`imported/${decoded.path}`);
    await this.refreshImported();
  }

  /**
   * Deletes a workflow that lives in ComfyUI's userdata. The file is removed on
   * the ComfyUI host, so it disappears for every client, not only for us.
   */
  async deleteRemote(key: string): Promise<void> {
    const decoded = decodeWorkflowKey(key);
    if (decoded.source !== 'remote') {
      throw new AppError(400, 'NOT_REMOTE', '只能删除 ComfyUI 上的工作流');
    }
    const path = validateRemoteWorkflowPath(decoded.path);
    if (!this.allowedRemotePaths.has(path)) {
      // Deletion is never guessed: the path has to come from a fresh listing.
      await this.list(true).catch(() => undefined);
    }
    if (!this.allowedRemotePaths.has(path)) {
      throw new AppError(404, 'WORKFLOW_NOT_FOUND', '工作流不存在，请刷新工作流列表');
    }
    try {
      await this.client.deleteWorkflowFile(path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'WORKFLOW_DELETE_FAILED', `删除工作流失败：${toErrorMessage(error)}`);
    }
    this.allowedRemotePaths.delete(path);
    this.items = this.items.filter(
      (item) => !(item.source === 'remote' && item.path === path),
    );
    // The file is gone, so keep the fresh list instead of re-fetching now.
    this.fetchedAt = Date.now();
    await this.persist();
  }

  async invalidate(): Promise<void> {
    this.fetchedAt = 0;
    this.loading = undefined;
  }
}
