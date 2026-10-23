import { createHash } from 'node:crypto';
import type { WorkflowFormat } from '@comfy-mobile/shared';
import {
  convertUiToApi,
  isApiFormat,
  isUiFormat,
} from '../../vendor/comfyui-converter/services/workflow-converter.js';
import { AppError } from '../errors.js';
import type { ApiPrompt, PromptNode } from '../comfy/client.js';

export interface ConversionResult {
  prompt: ApiPrompt;
  format: WorkflowFormat;
  warnings: string[];
  missingNodeTypes: { nodeId: string; classType: string; warning: string }[];
  potentiallyExecutableNodeCount: number;
}

const cache = new Map<string, ConversionResult>();
const MAX_CACHE = 24;

function isApiPrompt(value: unknown): value is ApiPrompt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (!entries.length) return false;
  return entries.every(
    (node) =>
      node !== null &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      typeof (node as Record<string, unknown>).class_type === 'string' &&
      (node as Record<string, unknown>).inputs !== null &&
      typeof (node as Record<string, unknown>).inputs === 'object',
  );
}

function unwrapApi(value: unknown): unknown {
  if (isApiPrompt(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (isApiPrompt(record.prompt)) return record.prompt;
    if (isApiPrompt(record.workflow)) return record.workflow;
  }
  return value;
}

export function detectFormat(value: unknown): WorkflowFormat | null {
  if (isUiFormat(value)) return 'ui';
  const unwrapped = unwrapApi(value);
  if (isApiPrompt(unwrapped)) return 'api';
  return null;
}

function objectInfoHash(objectInfo: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(objectInfo)).digest('hex').slice(0, 24);
}

function workflowHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

/**
 * Convert any supported workflow into an API prompt, caching the expensive
 * conversion by workflow + object_info content. The returned prompt is a fresh
 * clone owned by the caller.
 */
export function convertWorkflow(
  workflow: unknown,
  objectInfo: Record<string, unknown>,
): ConversionResult {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new AppError(400, 'BAD_WORKFLOW', '工作流内容不是 JSON 对象');
  }
  const format = detectFormat(workflow);
  if (!format) {
    throw new AppError(
      400,
      'UNSUPPORTED_WORKFLOW',
      '无法识别工作流格式；请使用 ComfyUI 保存的 UI 工作流或导出的 API 工作流',
    );
  }

  const key = `${format}:${workflowHash(workflow)}:${objectInfoHash(objectInfo)}`;
  const cached = cache.get(key);
  if (cached) {
    return {
      ...cached,
      prompt: structuredClone(cached.prompt),
    };
  }

  let result: ConversionResult;
  if (format === 'api') {
    const prompt = unwrapApi(workflow) as ApiPrompt;
    result = {
      prompt: structuredClone(prompt),
      format,
      warnings: [],
      missingNodeTypes: [],
      potentiallyExecutableNodeCount: Object.keys(prompt).length,
    };
  } else {
    const converted = convertUiToApi(
      workflow as Record<string, unknown>,
      objectInfo,
    );
    result = {
      prompt: converted.workflow as ApiPrompt,
      format,
      warnings: converted.warnings ?? [],
      missingNodeTypes: converted.missingNodeTypes ?? [],
      potentiallyExecutableNodeCount: converted.potentiallyExecutableNodeCount ?? 0,
    };
    if (!Object.keys(result.prompt).length) {
      throw new AppError(
        422,
        'EMPTY_CONVERSION',
        '工作流转换后没有可执行节点，请检查是否所有节点都被静音或缺少自定义节点',
        { warnings: result.warnings, missingNodeTypes: result.missingNodeTypes },
      );
    }
  }

  cache.set(key, result);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return {
    ...result,
    prompt: structuredClone(result.prompt),
  };
}

export function clearConversionCache(): void {
  cache.clear();
}

export function nodeLabelMap(
  workflow: unknown,
  prompt: ApiPrompt,
): Record<string, string> {
  const labels: Record<string, string> = {};
  const ui = workflow as Record<string, unknown> | null;
  if (ui && Array.isArray(ui.nodes)) {
    for (const item of ui.nodes) {
      if (!item || typeof item !== 'object') continue;
      const node = item as Record<string, unknown>;
      if (node.id === undefined) continue;
      const label =
        (typeof node.title === 'string' && node.title.trim()) ||
        (typeof node.type === 'string' ? node.type : '');
      if (label) labels[String(node.id)] = label;
    }
  }
  for (const [id, node] of Object.entries(prompt)) {
    if (labels[id]) continue;
    const meta = (node as PromptNode)._meta;
    labels[id] = meta?.title || node.class_type || id;
  }
  return labels;
}
