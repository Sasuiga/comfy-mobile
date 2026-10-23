import { randomInt } from 'node:crypto';
import type { Field } from '@comfy-mobile/shared';
import type { ApiPrompt, PromptNode } from '../comfy/client.js';
import { AppError } from '../errors.js';

export interface ApplyValuesResult {
  prompt: ApiPrompt;
  resolvedSeeds: Record<string, number>;
}

type JsonRecord = Record<string, unknown>;

function resolveNode(prompt: ApiPrompt, nodeId: string): [string, PromptNode] | null {
  if (prompt[nodeId]) return [nodeId, prompt[nodeId]];
  const suffix = `:${nodeId}`;
  const candidates = Object.entries(prompt).filter(([key]) => key.endsWith(suffix));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new AppError(
      409,
      'AMBIGUOUS_NODE',
      `节点 ${nodeId} 匹配到多个子图节点，无法安全写入参数`,
      { candidates: candidates.map(([key]) => key) },
    );
  }
  return null;
}

function clampNumber(value: number, field: Field): number {
  const { min, max } = field.constraints;
  let result = value;
  if (typeof min === 'number' && result < min) result = min;
  if (typeof max === 'number' && result > max) result = max;
  if (field.constraints.integer) result = Math.round(result);
  return result;
}

function coerce(field: Field, raw: unknown): unknown {
  if (raw === undefined || raw === null) {
    throw new AppError(400, 'INVALID_VALUE', `${field.label} 不能为空`, { key: field.key });
  }
  switch (field.kind) {
    case 'number':
    case 'slider':
    case 'seed': {
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(number)) {
        throw new AppError(400, 'INVALID_VALUE', `${field.label} 必须是数字`, {
          key: field.key,
        });
      }
      return clampNumber(number, field);
    }
    case 'toggle': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 0 || raw === '0') return false;
      throw new AppError(400, 'INVALID_VALUE', `${field.label} 必须是布尔值`, {
        key: field.key,
      });
    }
    case 'select': {
      const value = String(raw);
      const options = field.constraints.options ?? [];
      if (options.length && !options.some((option) => option.value === value)) {
        throw new AppError(400, 'INVALID_OPTION', `${field.label} 的选项已失效，请重新选择`, {
          key: field.key,
          value,
        });
      }
      return value;
    }
    case 'image':
    case 'text':
    case 'textarea': {
      const value = String(raw);
      const max = field.constraints.maxLength;
      if (max !== undefined && value.length > max) {
        throw new AppError(400, 'VALUE_TOO_LONG', `${field.label} 超出长度限制`, {
          key: field.key,
        });
      }
      return value;
    }
    default:
      return raw;
  }
}

export function applyValues(
  prompt: ApiPrompt,
  fields: Field[],
  values: Record<string, unknown>,
  randomizeSeeds: boolean,
): ApplyValuesResult {
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const patched = structuredClone(prompt);
  for (const key of Object.keys(values)) {
    if (!fieldByKey.has(key)) {
      throw new AppError(400, 'UNKNOWN_FIELD', `未知参数：${key}`, { key });
    }
  }

  for (const field of fields) {
    const supplied = Object.prototype.hasOwnProperty.call(values, field.key);
    let value: unknown;
    if (field.kind === 'seed' && randomizeSeeds) {
      value = randomInt(0, 2 ** 32);
    } else if (supplied) {
      value = coerce(field, values[field.key]);
    } else {
      continue;
    }

    const resolved = resolveNode(patched, field.nodeId);
    if (!resolved) {
      throw new AppError(
        422,
        'NODE_NOT_FOUND',
        `工作流中找不到节点 ${field.nodeId}，请刷新工作流或重新生成表单`,
        { key: field.key, nodeId: field.nodeId },
      );
    }
    const [, node] = resolved;
    let inputName = field.input;
    if (!Object.prototype.hasOwnProperty.call(node.inputs, inputName)) {
      if (Object.prototype.hasOwnProperty.call(node.inputs, field.widgetName)) {
        inputName = field.widgetName;
      } else {
        throw new AppError(
          422,
          'INPUT_NOT_FOUND',
          `节点 ${field.nodeId} 中找不到参数 ${field.input}，工作流可能已更新`,
          { key: field.key, input: field.input },
        );
      }
    }
    node.inputs[inputName] = value;
  }

  const resolvedSeeds: Record<string, number> = {};
  for (const field of fields) {
    if (field.kind !== 'seed') continue;
    const resolved = resolveNode(patched, field.nodeId);
    if (!resolved) continue;
    const [, node] = resolved;
    const value = node.inputs[field.input] ?? node.inputs[field.widgetName];
    if (typeof value === 'number' && Number.isFinite(value)) {
      resolvedSeeds[field.key] = value;
    }
  }

  return { prompt: patched, resolvedSeeds };
}

export interface MappedNodeError {
  nodeId: string;
  fieldKey?: string;
  message: string;
  details?: unknown;
}

export function mapNodeErrors(details: unknown, fields: Field[]): MappedNodeError[] {
  const record = details as JsonRecord | undefined;
  const nodeErrors = record?.node_errors ?? (record?.body as JsonRecord | undefined)?.node_errors;
  if (!nodeErrors || typeof nodeErrors !== 'object') return [];
  const byNode = new Map<string, Field[]>();
  for (const field of fields) {
    const list = byNode.get(field.nodeId) ?? [];
    list.push(field);
    byNode.set(field.nodeId, list);
  }
  const mapped: MappedNodeError[] = [];
  for (const [nodeId, value] of Object.entries(nodeErrors as JsonRecord)) {
    const nodeFields = byNode.get(nodeId) ?? [];
    const nodeRecord = value && typeof value === 'object' ? (value as JsonRecord) : undefined;
    const errors = Array.isArray(nodeRecord?.errors) ? nodeRecord.errors : [];
    if (!errors.length) {
      mapped.push({ nodeId, message: '该节点参数不合法', fieldKey: nodeFields[0]?.key });
      continue;
    }
    for (const error of errors) {
      const item = error && typeof error === 'object' ? (error as JsonRecord) : {};
      const message =
        typeof item.message === 'string'
          ? item.message
          : typeof item.details === 'string'
            ? item.details
            : '参数不合法';
      const inputName =
        typeof item.input_name === 'string'
          ? item.input_name
          : typeof item.input === 'string'
            ? item.input
            : undefined;
      const field =
        (inputName && nodeFields.find((candidate) => candidate.input === inputName)) ||
        nodeFields[0];
      mapped.push({
        nodeId,
        fieldKey: field?.key,
        message,
        details: item,
      });
    }
  }
  return mapped;
}
