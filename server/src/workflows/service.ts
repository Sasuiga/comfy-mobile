import { createHash, randomUUID } from 'node:crypto';
import type {
  Field,
  FieldOverride,
  FormOverrides,
  ListTemplatesResponse,
  Preset,
  SavePresetRequest,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowTemplate,
} from '@comfy-mobile/shared';
import { isAssetRef } from '@comfy-mobile/shared';
import type { ApiPrompt } from '../comfy/client.js';
import type { ComfyClient } from '../comfy/client.js';
import type { AssetStore } from '../assets/store.js';
import type { JsonStore } from '../store/jsonStore.js';
import { AppError, toErrorMessage } from '../errors.js';
import { decodeWorkflowKey, shortHash } from '../security.js';
import { clearConversionCache, convertWorkflow, nodeLabelMap } from './convert.js';
import type { WorkflowRepository, RawWorkflow } from './repository.js';
import { buildFormSchema, type BuiltSchema } from './schema.js';
import { applyValues, type ApplyValuesResult } from './patch.js';

interface ObjectInfoCacheFile {
  fetchedAt: string;
  hash: string;
  data: Record<string, unknown>;
}

interface PresetFile {
  presets: Preset[];
}

export interface RuntimeWorkflow {
  raw: RawWorkflow;
  prompt: ApiPrompt;
  warnings: string[];
  missingNodeTypes: { nodeId: string; classType: string; warning: string }[];
  nodeLabels: Record<string, string>;
  objectInfoHash: string;
  hasAppConfig: boolean;
}

export interface RunPreparation {
  schema: BuiltSchema;
  detail: WorkflowDetail;
  runtime: RuntimeWorkflow;
  applied: ApplyValuesResult;
  warnings: string[];
  /** Bypass ids accepted for this run, after schema validation. */
  bypass: string[];
}

function hashKey(key: string): string {
  return shortHash(key, 32);
}

function normalizeOverrides(raw: FormOverrides | null): FormOverrides | null {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.fields)) return null;
  const fields: FieldOverride[] = [];
  for (const item of raw.fields.slice(0, 2000)) {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string') continue;
    fields.push({ ...item });
  }
  return {
    version: 1,
    fields,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export class WorkflowService {
  private objectInfo?: Record<string, unknown>;
  private objectInfoHashValue = '';
  private objectInfoFetchedAt = 0;
  private objectInfoWarning?: string;
  private templateCache?: { items: WorkflowTemplate[]; fetchedAt: number };
  /** ComfyUI input value per asset path, invalidated by size + mtime. */
  private readonly assetUploads = new Map<string, { signature: string; value: string }>();

  constructor(
    private readonly store: JsonStore,
    private readonly repository: WorkflowRepository,
    private readonly client: ComfyClient,
    private readonly assets: AssetStore,
  ) {}

  async load(): Promise<void> {
    const cached = await this.store.readOrNull<ObjectInfoCacheFile>('cache/object-info.json');
    if (cached?.data && typeof cached.data === 'object') {
      this.objectInfo = cached.data;
      this.objectInfoHashValue =
        cached.hash || createHash('sha256').update(JSON.stringify(cached.data)).digest('hex');
      this.objectInfoFetchedAt = Date.parse(cached.fetchedAt) || 0;
    }
    await this.repository.load();
  }

  async listWorkflows(force = false): Promise<WorkflowSummary[]> {
    return this.repository.list(force);
  }

  async getObjectInfo(force = false): Promise<Record<string, unknown>> {
    if (this.objectInfo && !force) return this.objectInfo;
    try {
      const fresh = await this.client.getObjectInfo(force);
      this.objectInfo = fresh;
      this.objectInfoHashValue = createHash('sha256').update(JSON.stringify(fresh)).digest('hex');
      this.objectInfoFetchedAt = Date.now();
      this.objectInfoWarning = undefined;
      await this.store.write('cache/object-info.json', {
        fetchedAt: new Date(this.objectInfoFetchedAt).toISOString(),
        hash: this.objectInfoHashValue,
        data: fresh,
      } satisfies ObjectInfoCacheFile);
      return fresh;
    } catch (error) {
      if (this.objectInfo) {
        this.objectInfoWarning = '无法刷新 ComfyUI 节点信息，正在使用缓存';
        return this.objectInfo;
      }
      throw error;
    }
  }

  async refreshObjectInfo(): Promise<{ hash: string; fetchedAt: string }> {
    await this.getObjectInfo(true);
    return {
      hash: this.objectInfoHashValue,
      fetchedAt: new Date(this.objectInfoFetchedAt).toISOString(),
    };
  }

  async getRuntime(key: string): Promise<RuntimeWorkflow> {
    const raw = await this.repository.getRaw(key);
    const objectInfo = await this.getObjectInfo();
    const converted = convertWorkflow(raw.workflow, objectInfo);
    return {
      raw: {
        ...raw,
        summary: {
          ...raw.summary,
          format: converted.format,
          hasAppConfig: raw.summary.hasAppConfig,
        },
      },
      prompt: converted.prompt,
      warnings: converted.warnings,
      missingNodeTypes: converted.missingNodeTypes,
      nodeLabels: nodeLabelMap(raw.workflow, converted.prompt),
      objectInfoHash: this.objectInfoHashValue,
      hasAppConfig: Boolean(raw.summary.hasAppConfig),
    };
  }

  async getOverrides(key: string): Promise<FormOverrides | null> {
    return normalizeOverrides(
      await this.store.readOrNull<FormOverrides>(`forms/${hashKey(key)}.json`),
    );
  }

  async saveOverrides(key: string, fields: FieldOverride[]): Promise<FormOverrides> {
    if (!Array.isArray(fields)) {
      throw new AppError(400, 'INVALID_OVERRIDES', '表单配置格式不正确');
    }
    const clean: FieldOverride[] = [];
    for (const item of fields.slice(0, 2000)) {
      if (!item || typeof item !== 'object' || typeof item.key !== 'string') {
        throw new AppError(400, 'INVALID_OVERRIDES', '每个字段覆盖都需要 key');
      }
      clean.push({
        key: item.key,
        label: typeof item.label === 'string' ? item.label.slice(0, 200) : undefined,
        description:
          typeof item.description === 'string' ? item.description.slice(0, 1000) : undefined,
        kind: item.kind,
        group: typeof item.group === 'string' ? item.group.slice(0, 80) : undefined,
        order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : undefined,
        visible: typeof item.visible === 'boolean' ? item.visible : undefined,
        advanced: typeof item.advanced === 'boolean' ? item.advanced : undefined,
      });
    }
    const overrides: FormOverrides = {
      version: 1,
      fields: clean,
      updatedAt: new Date().toISOString(),
    };
    await this.store.write(`forms/${hashKey(key)}.json`, overrides);
    return overrides;
  }

  async resetOverrides(key: string): Promise<void> {
    await this.store.remove(`forms/${hashKey(key)}.json`);
  }

  async getSchema(key: string): Promise<{ detail: WorkflowDetail; schema: BuiltSchema; runtime: RuntimeWorkflow }> {
    const runtime = await this.getRuntime(key);
    const overrides = await this.getOverrides(key);
    const warnings = [...runtime.warnings];
    if (this.objectInfoWarning) warnings.push(this.objectInfoWarning);
    const schema = buildFormSchema({
      workflowKey: key,
      summary: runtime.raw.summary,
      workflow: runtime.raw.workflow,
      prompt: runtime.prompt,
      objectInfo: this.objectInfo ?? {},
      overrides,
      warnings,
      missingNodeTypes: runtime.missingNodeTypes,
    });
    const detail: WorkflowDetail = {
      ...runtime.raw.summary,
      format: runtime.raw.summary.format,
      hasAppConfig: Boolean(runtime.hasAppConfig),
      fields: schema.fields,
      groups: schema.groups,
      warnings: schema.warnings,
      staleOverrides: schema.staleOverrides,
      missingNodeTypes: runtime.missingNodeTypes,
      fieldCount: schema.fields.filter((field) => field.visible).length,
    };
    return { detail, schema, runtime };
  }

  async prepareRun(
    key: string,
    values: Record<string, unknown>,
    randomizeSeeds: boolean,
    bypass: string[] = [],
  ): Promise<RunPreparation> {
    const { detail, schema, runtime } = await this.getSchema(key);
    const allowed = new Set(
      schema.fields
        .filter((field) => field.nodeBypassable || field.skippable)
        .map((field) => field.nodeId),
    );
    const bypassed = new Set(bypass.filter((nodeId) => allowed.has(nodeId)));
    const resolvedValues = await this.resolveAssetValues(schema.fields, values, bypassed);
    const applied = applyValues(runtime.prompt, schema.fields, resolvedValues, randomizeSeeds, {
      bypass: [...bypassed],
      objectInfo: this.objectInfo ?? {},
    });
    return {
      detail,
      schema,
      runtime,
      applied,
      warnings: schema.warnings,
      bypass: [...bypassed],
    };
  }

  /**
   * Asset inputs are stored on the configured drive. At run time each one is
   * uploaded to ComfyUI and replaced with the value a LoadImage node expects.
   * Uploads are cached per file signature so re-running is cheap.
   */
  private async resolveAssetValues(
    fields: Field[],
    values: Record<string, unknown>,
    bypassed: Set<string> = new Set(),
  ): Promise<Record<string, unknown>> {
    const resolved = { ...values };
    for (const field of fields) {
      if (field.kind !== 'image') continue;
      // Values for bypassed nodes never reach the prompt; skip the upload.
      if (bypassed.has(field.nodeId)) continue;
      const raw = resolved[field.key];
      if (!isAssetRef(raw)) continue;
      let cached = this.assetUploads.get(raw.path);
      try {
        const file = await this.assets.readForUpload(raw.path);
        if (!cached || cached.signature !== file.signature) {
          const result = await this.client.uploadFile(
            file.buffer,
            file.filename,
            file.mime,
            'input',
          );
          const value =
            result.assetHash ||
            (result.subfolder ? `${result.subfolder}/${result.name}` : result.name);
          cached = { signature: file.signature, value };
          this.assetUploads.set(raw.path, cached);
        }
      } catch (error) {
        const status =
          error instanceof AppError && error.statusCode < 500 ? error.statusCode : 502;
        throw new AppError(
          status,
          'ASSET_PREPARE_FAILED',
          `素材「${raw.name ?? raw.path}」无法用于运行：${toErrorMessage(error)}`,
          { key: field.key, path: raw.path },
        );
      }
      resolved[field.key] = cached.value;
    }
    return resolved;
  }

  async importWorkflow(name: string | undefined, workflow: unknown): Promise<WorkflowSummary> {
    return this.repository.importWorkflow(name, workflow);
  }

  async listTemplates(refresh = false): Promise<ListTemplatesResponse> {
    const ttl = 10 * 60_000;
    if (
      refresh ||
      !this.templateCache ||
      Date.now() - this.templateCache.fetchedAt > ttl
    ) {
      const items = await this.client.listWorkflowTemplates();
      this.templateCache = { items, fetchedAt: Date.now() };
    }
    return {
      items: this.templateCache.items,
      fetchedAt: new Date(this.templateCache.fetchedAt).toISOString(),
    };
  }

  /** Fetch a bundled ComfyUI template and store it as a local workflow. */
  async importTemplate(name: string): Promise<WorkflowSummary> {
    const { items } = await this.listTemplates(false);
    const meta = items.find((item) => item.name === name);
    if (!meta) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', '模板不存在，请刷新模板列表');
    }
    const workflow = await this.client.readWorkflowTemplate(meta.name);
    return this.repository.importWorkflow(meta.title, workflow);
  }

  async deleteImported(key: string): Promise<void> {
    await this.repository.deleteImported(key);
    await this.resetOverrides(key);
    await this.store.remove(`presets/${hashKey(key)}.json`);
  }

  /**
   * Deletes a workflow: imported ones are local copies, ComfyUI ones are the
   * saved file itself (removed on the ComfyUI host). Form overrides and presets
   * belong to the key either way and go with it.
   */
  async deleteWorkflow(key: string): Promise<void> {
    const decoded = decodeWorkflowKey(key);
    if (decoded.source === 'imported') {
      await this.repository.deleteImported(key);
    } else {
      await this.repository.deleteRemote(key);
    }
    await this.resetOverrides(key);
    await this.store.remove(`presets/${hashKey(key)}.json`);
  }

  async listPresets(key: string): Promise<Preset[]> {
    const data = await this.store.read<PresetFile>(`presets/${hashKey(key)}.json`, { presets: [] });
    return Array.isArray(data.presets) ? data.presets : [];
  }

  async createPreset(key: string, request: SavePresetRequest): Promise<Preset> {
    const name = (request.name || '').trim();
    if (!name) throw new AppError(400, 'PRESET_NAME_REQUIRED', '请输入预设名称');
    if (!request.values || typeof request.values !== 'object' || Array.isArray(request.values)) {
      throw new AppError(400, 'INVALID_PRESET', '预设参数格式不正确');
    }
    const presets = await this.listPresets(key);
    if (presets.length >= 100) {
      throw new AppError(400, 'TOO_MANY_PRESETS', '每个工作流最多保存 100 个预设');
    }
    const now = new Date().toISOString();
    const preset: Preset = {
      id: randomUUID(),
      workflowKey: key,
      name: name.slice(0, 100),
      values: request.values,
      randomizeSeeds: Boolean(request.randomizeSeeds),
      createdAt: now,
      updatedAt: now,
    };
    presets.push(preset);
    await this.writePresets(key, presets);
    return preset;
  }

  async updatePreset(
    key: string,
    id: string,
    request: SavePresetRequest,
  ): Promise<Preset> {
    const presets = await this.listPresets(key);
    const preset = presets.find((item) => item.id === id);
    if (!preset) throw new AppError(404, 'PRESET_NOT_FOUND', '预设不存在');
    if (typeof request.name === 'string' && request.name.trim()) {
      preset.name = request.name.trim().slice(0, 100);
    }
    if (request.values && typeof request.values === 'object' && !Array.isArray(request.values)) {
      preset.values = request.values;
    }
    if (request.randomizeSeeds !== undefined) {
      preset.randomizeSeeds = Boolean(request.randomizeSeeds);
    }
    preset.updatedAt = new Date().toISOString();
    await this.writePresets(key, presets);
    return preset;
  }

  async deletePreset(key: string, id: string): Promise<void> {
    const presets = await this.listPresets(key);
    const next = presets.filter((item) => item.id !== id);
    if (next.length === presets.length) {
      throw new AppError(404, 'PRESET_NOT_FOUND', '预设不存在');
    }
    await this.writePresets(key, next);
  }

  private async writePresets(key: string, presets: Preset[]): Promise<void> {
    await this.store.write(`presets/${hashKey(key)}.json`, { presets } satisfies PresetFile);
  }

  async invalidateCaches(options: { workflows?: boolean; objectInfo?: boolean; conversion?: boolean } = {}): Promise<void> {
    if (options.workflows) await this.repository.invalidate();
    if (options.objectInfo) {
      this.objectInfo = undefined;
      this.objectInfoHashValue = '';
      this.objectInfoFetchedAt = 0;
      await this.store.remove('cache/object-info.json');
    }
    if (options.conversion !== false) clearConversionCache();
  }

  get objectInfoHash(): string {
    return this.objectInfoHashValue;
  }
}
