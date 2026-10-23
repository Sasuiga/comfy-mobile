import type { WorkflowFormat, WorkflowSummary } from '@comfy-mobile/shared';
import type { ComfyClient, UserDataItem } from '../comfy/client.js';
import type { JsonStore } from '../store/jsonStore.js';
import { AppError, toErrorMessage } from '../errors.js';
import { decodeWorkflowKey, shortHash, validateRemoteWorkflowPath, workflowKey } from '../security.js';
import { detectFormat } from './convert.js';
import { parseLinearData } from './linear.js';

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
    if (!force && Date.now() - this.fetchedAt < LIST_TTL_MS && this.items.length) {
      return this.items;
    }
    if (!force && Date.now() - this.fetchedAt < LIST_TTL_MS) {
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
      hasAppConfig: cachedByPath.get(item.path)?.hasAppConfig,
    }));

    const pending = summaries.filter((item) => item.format === undefined);
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
      imported.push({
        key: workflowKey('imported', file),
        name: baseName(file),
        path: file,
        source: 'imported',
        format: 'api',
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
          format: 'api',
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
    if (format !== 'api') {
      throw new AppError(
        400,
        'NOT_API_WORKFLOW',
        '导入功能只接受 ComfyUI 导出的 API 格式工作流；普通 UI 工作流可以直接从列表选择',
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

  async invalidate(): Promise<void> {
    this.fetchedAt = 0;
    this.loading = undefined;
  }
}
