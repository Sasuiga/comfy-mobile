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
      warnings: relaxVacuousShiftWarnings(converted.warnings ?? [], objectInfo),
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

const UNMAPPED_FORCE_INPUT_WARNING =
  /^Node (\S+) \((.+?)\): (\d+) saved widget value\(s\) remain unmapped[\s\S]*forceInput-only input/;

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);

/** Mirrors the converter's notion of a spec that maps to a widget slot. */
function isPositionalWidgetSpec(spec: unknown): boolean {
  if (!Array.isArray(spec)) return false;
  const type = spec[0];
  if (Array.isArray(type)) return true; // inline combo options
  const cfg = spec[1] as Record<string, unknown> | undefined;
  if (Array.isArray(cfg?.options)) return true; // dynamic combo
  if (typeof cfg?.widgetType === 'string' && WIDGET_TYPES.has(cfg.widgetType)) {
    return true;
  }
  if (typeof type !== 'string') return false;
  if (WIDGET_TYPES.has(type)) return true;
  if (!type.includes(',')) return false;
  const parts = type.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => WIDGET_TYPES.has(part));
}

/** `forceInput` (any type) or a deprecated optional `defaultInput` hides the slot. */
function isSocketOnlySpec(spec: unknown, optional: boolean): boolean {
  if (!Array.isArray(spec)) return false;
  const cfg = spec[1] as Record<string, unknown> | undefined;
  if (cfg?.forceInput === true) return true;
  return optional && cfg?.defaultInput === true;
}

/** True when the class owns at least one slot a saved row could shift into. */
function classHasWidgetSlots(def: unknown): boolean {
  if (!def || typeof def !== 'object') return false;
  const input = (def as { input?: { required?: unknown; optional?: unknown } }).input;
  const required = (input?.required ?? {}) as Record<string, unknown>;
  const optional = (input?.optional ?? {}) as Record<string, unknown>;
  for (const [name, spec] of Object.entries(required)) {
    if (isPositionalWidgetSpec(spec) && !isSocketOnlySpec(spec, false)) return true;
  }
  for (const [name, spec] of Object.entries(optional)) {
    if (name in required) continue;
    if (isPositionalWidgetSpec(spec) && !isSocketOnlySpec(spec, true)) return true;
  }
  return false;
}

/**
 * The converter reports any leftover `widgets_values` entry on a node that also
 * has a forceInput-only input as "every widget on this node is reading one
 * position early". That only holds when the node has widget slots at all:
 * display nodes such as `ShowText|pysssss` (a single socket-only `text` input)
 * still serialize a linked value into `widgets_values`, and nothing on them can
 * move. Report those leftovers, but do not call them parameter misalignment —
 * the UI escalates that wording to "do not run until you re-save".
 */
function relaxVacuousShiftWarnings(
  warnings: string[],
  objectInfo: Record<string, unknown>,
): string[] {
  return warnings.map((warning) => {
    const match = UNMAPPED_FORCE_INPUT_WARNING.exec(warning);
    if (!match || classHasWidgetSlots(objectInfo[match[2]!])) return warning;
    return (
      `Node ${match[1]} (${match[2]}): ${match[3]} 个多余的序列化值被忽略` +
      '——该节点只有输入端口，没有可错位的参数'
    );
  });
}

export function clearConversionCache(): void {
  cache.clear();
}

/** Progress lines have one line of space, so keep only the useful title part. */
function progressLabel(title: string | undefined, fallback: string): string {
  const text = (title ?? '').trim();
  if (!text) return fallback;
  const [prefix] = text.split(/[：:]/);
  const context = prefix?.trim() ?? '';
  if (context && context.length <= 20) return context;
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
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
      const type = typeof node.type === 'string' ? node.type : '';
      const label = progressLabel(
        typeof node.title === 'string' ? node.title : undefined,
        type,
      );
      if (label) labels[String(node.id)] = label;
    }
  }
  for (const [id, node] of Object.entries(prompt)) {
    if (labels[id]) continue;
    const meta = (node as PromptNode)._meta;
    labels[id] = progressLabel(meta?.title, node.class_type || id);
  }
  return labels;
}
