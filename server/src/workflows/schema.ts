import type {
  Field,
  FieldConstraints,
  FieldGroup,
  FieldKind,
  FieldOption,
  FormOverrides,
  WorkflowSummary,
} from '@comfy-mobile/shared';
import { DEFAULT_GROUPS } from '@comfy-mobile/shared';
import type { ApiPrompt } from '../comfy/client.js';
import { parseLinearData, type LinearInput } from './linear.js';
import { parseMarker, type MarkerInfo } from './markers.js';

type JsonRecord = Record<string, unknown>;

interface NodeDefinition {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  input_order?: {
    required?: string[];
    optional?: string[];
  };
  output?: unknown[];
  output_name?: string[];
  display_name?: string;
  category?: string;
}

interface InputSpec {
  type: unknown;
  cfg: JsonRecord | undefined;
  required: boolean;
}

export interface BuildSchemaInput {
  workflowKey: string;
  summary: WorkflowSummary;
  workflow: unknown;
  prompt: ApiPrompt;
  objectInfo: Record<string, unknown>;
  overrides: FormOverrides | null;
  warnings: string[];
  missingNodeTypes: { nodeId: string; classType: string; warning: string }[];
}

export interface BuiltSchema {
  fields: Field[];
  groups: FieldGroup[];
  warnings: string[];
  staleOverrides: string[];
}

const SKIP_CLASS_TYPES = new Set([
  'Note',
  'MarkdownNote',
  'Reroute',
  'PrimitiveNode',
  'GetNode',
  'SetNode',
  'PRO_GetNode',
  'PRO_SetNode',
  'SetNode_GetNode',
  'SetNode_SetNode',
  'Label (rgthree)',
]);

const INPUT_LABELS: Record<string, string> = {
  text: '提示词',
  seed: '随机种子',
  noise_seed: '随机种子',
  steps: '步数',
  cfg: '提示词引导 (CFG)',
  sampler_name: '采样器',
  scheduler: '调度器',
  denoise: '降噪强度',
  width: '宽度',
  height: '高度',
  batch_size: '批次数量',
  ckpt_name: '大模型',
  unet_name: 'UNET 模型',
  clip_name: 'CLIP 模型',
  vae_name: 'VAE 模型',
  lora_name: 'LoRA',
  strength_model: '模型强度',
  strength_clip: 'CLIP 强度',
  image: '输入图片',
  filename_prefix: '文件名前缀',
  positive: '正向条件',
  negative: '反向条件',
  latent_image: 'Latent 图像',
  model: '模型',
  clip: 'CLIP',
  vae: 'VAE',
  samples: '图像',
  pixels: '像素',
  upscale_method: '放大算法',
  crop: '裁剪',
  megapixels: '百万像素',
  resolution: '分辨率',
  aspect_ratio: '画幅比例',
  frame_rate: '帧率',
  fps: '帧率',
  frames: '帧数',
  length: '长度',
};

const CLASS_LABELS: Record<string, string> = {
  CLIPTextEncode: '提示词',
  CLIPTextEncodeSDXL: '提示词',
  KSampler: '采样器',
  KSamplerAdvanced: '高级采样器',
  CheckpointLoaderSimple: '模型加载',
  CheckpointLoader: '模型加载',
  UNETLoader: 'UNET 加载',
  CLIPLoader: 'CLIP 加载',
  VAELoader: 'VAE 加载',
  LoraLoader: 'LoRA',
  LoraLoaderModelOnly: 'LoRA',
  EmptyLatentImage: '画布尺寸',
  EmptySD3LatentImage: '画布尺寸',
  LoadImage: '输入图片',
  LoadImageMask: '输入蒙版',
  SaveImage: '保存图片',
  PreviewImage: '预览图片',
  VAEDecode: 'VAE 解码',
  VAEEncode: 'VAE 编码',
  ImageScale: '图像缩放',
  ImageScaleBy: '图像缩放',
  LatentUpscale: 'Latent 放大',
  SaveAnimatedWEBP: '动图输出',
  SaveAnimatedPNG: '动图输出',
  VHS_VideoCombine: '视频输出',
};

const PROMPT_CLASSES = new Set([
  'CLIPTextEncode',
  'CLIPTextEncodeSDXL',
  'CLIPTextEncodeSDXLRefiner',
  'BNK_CLIPTextEncodeAdvanced',
]);

const MODEL_INPUTS = new Set([
  'ckpt_name',
  'unet_name',
  'clip_name',
  'clip_name1',
  'clip_name2',
  'vae_name',
  'lora_name',
]);

const SAMPLING_INPUTS = new Set([
  'seed',
  'noise_seed',
  'steps',
  'cfg',
  'sampler_name',
  'scheduler',
  'denoise',
  'start_at_step',
  'end_at_step',
  'add_noise',
  'return_with_leftover_noise',
]);

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function getDefinition(
  objectInfo: Record<string, unknown>,
  classType: string,
): NodeDefinition | undefined {
  const def = objectInfo[classType];
  return def && typeof def === 'object' ? (def as NodeDefinition) : undefined;
}

function getInputSpec(def: NodeDefinition | undefined, input: string): InputSpec | undefined {
  const required = def?.input?.required?.[input];
  if (required !== undefined) {
    const spec = required as unknown[];
    return {
      type: Array.isArray(spec) ? spec[0] : spec,
      cfg: asRecord(Array.isArray(spec) ? spec[1] : undefined),
      required: true,
    };
  }
  const optional = def?.input?.optional?.[input];
  if (optional !== undefined) {
    const spec = optional as unknown[];
    return {
      type: Array.isArray(spec) ? spec[0] : spec,
      cfg: asRecord(Array.isArray(spec) ? spec[1] : undefined),
      required: false,
    };
  }
  return undefined;
}

function comboOptions(type: unknown, cfg: JsonRecord | undefined): FieldOption[] | undefined {
  let raw: unknown;
  if (Array.isArray(type)) raw = type;
  else if (type === 'COMBO') raw = cfg?.options ?? cfg?.values ?? cfg?.items;
  else if (Array.isArray(cfg?.options)) raw = cfg.options;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const options: FieldOption[] = [];
  for (const item of raw) {
    let value: string | undefined;
    let label: string | undefined;
    if (typeof item === 'string' || typeof item === 'number') {
      value = String(item);
      label = value;
    } else {
      const record = asRecord(item);
      if (!record) continue;
      const rawValue = record.value ?? record.name ?? record.id ?? record.key;
      if (typeof rawValue !== 'string' && typeof rawValue !== 'number') continue;
      value = String(rawValue);
      const rawLabel = record.label ?? record.display_name ?? record.name ?? value;
      label = typeof rawLabel === 'string' ? rawLabel : value;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: label || value });
  }
  return options;
}

function typeName(type: unknown, cfg: JsonRecord | undefined): string {
  if (typeof cfg?.widgetType === 'string') return cfg.widgetType;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return 'COMBO';
  return '';
}

function isCombo(type: unknown, cfg: JsonRecord | undefined): boolean {
  if (Array.isArray(type)) return true;
  const name = typeName(type, cfg);
  return name === 'COMBO' || name === 'COMBO,STRING';
}

function numericConfig(cfg: JsonRecord | undefined, key: 'min' | 'max' | 'step'): number | undefined {
  const value = cfg?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function isLinkRef(value: unknown, prompt: ApiPrompt): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [source, slot] = value;
  if (typeof slot !== 'number' || !Number.isInteger(slot)) return false;
  if (typeof source !== 'string' && typeof source !== 'number') return false;
  return Object.prototype.hasOwnProperty.call(prompt, String(source));
}

function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function translatedInputLabel(input: string): string {
  return INPUT_LABELS[input] ?? humanize(input);
}

function classLabel(classType: string): string {
  if (CLASS_LABELS[classType]) return CLASS_LABELS[classType]!;
  return classType;
}

function isGenericNodeTitle(title: string, classType: string): boolean {
  if (!title.trim()) return true;
  return title === classType || /^[A-Za-z0-9_]+$/.test(title);
}

function nodeBaseLabel(
  classType: string,
  title: string,
  marker: MarkerInfo,
): string {
  if (marker.label) return marker.label;
  const cleaned = marker.cleanTitle || title;
  if (cleaned && !isGenericNodeTitle(cleaned, classType)) return cleaned;
  return classLabel(classType);
}

function groupFor(classType: string, input: string): string {
  if (/\b(save|preview|combine)\b/i.test(classType) || input === 'filename_prefix') {
    return 'output';
  }
  if (/LoadImage|LoadImageMask|LoadImageOutput/.test(classType) || input === 'image') {
    return 'image';
  }
  if (MODEL_INPUTS.has(input) || /Loader/.test(classType)) return 'model';
  if (SAMPLING_INPUTS.has(input) || /Sampler/.test(classType)) return 'sampling';
  if (PROMPT_CLASSES.has(classType) || input === 'text') return 'prompt';
  return 'advanced';
}

function labelFor(
  classType: string,
  input: string,
  title: string,
  marker: MarkerInfo,
): string {
  const base = nodeBaseLabel(classType, title, marker);
  const lowerTitle = (marker.cleanTitle || title).toLowerCase();
  if (input === 'text') {
    if (/negative|反向|负面/.test(lowerTitle)) return '反向提示词';
    if (/positive|正向|正面/.test(lowerTitle)) return '正向提示词';
    if (marker.label) return marker.label;
    if (!isGenericNodeTitle(marker.cleanTitle || title, classType)) return base;
    return '提示词';
  }
  const inputLabel = translatedInputLabel(input);
  if (isGenericNodeTitle(marker.cleanTitle || title, classType)) return inputLabel;
  if (base === inputLabel) return inputLabel;
  return `${base} · ${inputLabel}`;
}

function kindFor(
  classType: string,
  input: string,
  spec: InputSpec | undefined,
  value: unknown,
  marker: MarkerInfo,
  options: FieldOption[] | undefined,
): FieldKind {
  if (marker.kind) return marker.kind;
  if (input === 'seed' || input === 'noise_seed') return 'seed';
  if ((classType === 'LoadImage' || classType === 'LoadImageMask') && input === 'image') {
    return 'image';
  }
  if (options && options.length) return 'select';
  if (spec && isCombo(spec.type, spec.cfg)) return 'select';
  const type = typeName(spec?.type, spec?.cfg);
  if (type === 'BOOLEAN') return 'toggle';
  if (type === 'INT' || type === 'FLOAT' || type.includes('INT') || type.includes('FLOAT')) {
    const numeric = !type.split(',').some((part) => {
      const trimmed = part.trim();
      return trimmed && trimmed !== 'INT' && trimmed !== 'FLOAT';
    });
    if (numeric) {
      if (/width|height/.test(input)) return 'number';
      const min = numericConfig(spec?.cfg, 'min');
      const max = numericConfig(spec?.cfg, 'max');
      if (min !== undefined && max !== undefined && max - min <= 1000 && max > min) {
        return 'slider';
      }
      return 'number';
    }
  }
  if (type === 'STRING' || type === 'STRING,INT' || input === 'text') {
    const multiline =
      Boolean(spec?.cfg?.multiline) || (typeof value === 'string' && value.includes('\n'));
    if (input === 'text' || multiline) return 'textarea';
    return 'text';
  }
  if (typeof value === 'boolean') return 'toggle';
  if (typeof value === 'number') {
    const min = numericConfig(spec?.cfg, 'min');
    const max = numericConfig(spec?.cfg, 'max');
    return min !== undefined && max !== undefined ? 'slider' : 'number';
  }
  if (typeof value === 'string') return 'text';
  return 'text';
}

function constraintsFor(
  kind: FieldKind,
  spec: InputSpec | undefined,
  value: unknown,
  options: FieldOption[] | undefined,
  marker: MarkerInfo,
): FieldConstraints {
  const constraints: FieldConstraints = {};
  if (options) constraints.options = options;
  const min = marker.min ?? numericConfig(spec?.cfg, 'min');
  const max = marker.max ?? numericConfig(spec?.cfg, 'max');
  const step = marker.step ?? numericConfig(spec?.cfg, 'step');
  if (min !== undefined) constraints.min = min;
  if (max !== undefined) constraints.max = max;
  if (step !== undefined) constraints.step = step;
  const type = typeName(spec?.type, spec?.cfg);
  if (type.includes('INT') && !type.includes('FLOAT')) constraints.integer = true;
  if (kind === 'number' || kind === 'slider' || kind === 'seed') {
    if (constraints.integer === undefined) {
      constraints.integer = Number.isInteger(value) || !type.includes('FLOAT');
    }
    if (constraints.step === undefined) constraints.step = constraints.integer ? 1 : 0.01;
  }
  if (kind === 'seed') {
    constraints.min = 0;
    constraints.max = 4_294_967_295;
    constraints.step = 1;
    constraints.integer = true;
  }
  if (kind === 'textarea') {
    constraints.multiline = true;
    constraints.maxLength ??= 10_000;
  }
  if (kind === 'text') constraints.maxLength ??= 4_000;
  if (kind === 'select' && !constraints.options) constraints.options = [];
  return constraints;
}

function visibleByDefault(group: string): boolean {
  return true;
}

function mergeLinearFields(
  fields: Field[],
  linearInputs: LinearInput[],
  warnings: string[],
): void {
  const used = new Set<string>();
  for (let index = 0; index < linearInputs.length; index += 1) {
    const linear = linearInputs[index]!;
    const exactKey = `${linear.nodeId}.${linear.widgetName}`;
    let field = fields.find((item) => item.key === exactKey);
    if (!field) {
      const suffix = `:${linear.nodeId}`;
      const candidates = fields.filter(
        (item) =>
          item.nodeId.endsWith(suffix) &&
          (item.input === linear.widgetName || item.widgetName === linear.widgetName),
      );
      if (candidates.length > 1) {
        warnings.push(
          `App Builder 参数 ${linear.nodeId}.${linear.widgetName} 匹配到多个节点，已使用第一个`,
        );
      }
      field = candidates[0];
    }
    if (!field) {
      warnings.push(
        `App Builder 参数 ${linear.nodeId}.${linear.widgetName} 没有出现在可执行工作流中，已跳过`,
      );
      continue;
    }
    if (used.has(field.key)) continue;
    used.add(field.key);
    field.visible = true;
    field.advanced = false;
    field.source = 'linear';
    field.order = index * 10;
    if (linear.description) field.description = linear.description;
    if (linear.height && field.kind === 'textarea') {
      field.constraints.maxLength ??= 10_000;
    }
  }
}

export function buildFormSchema(input: BuildSchemaInput): BuiltSchema {
  const { prompt, objectInfo, overrides } = input;
  const ui = asRecord(input.workflow);
  const uiNodes = new Map<string, JsonRecord>();
  const uiPositions = new Map<string, { x: number; y: number }>();
  if (ui && Array.isArray(ui.nodes)) {
    for (const rawNode of ui.nodes) {
      const node = asRecord(rawNode);
      if (!node || node.id === undefined) continue;
      const id = String(node.id);
      uiNodes.set(id, node);
      const pos = Array.isArray(node.pos)
        ? { x: Number(node.pos[0]) || 0, y: Number(node.pos[1]) || 0 }
        : { x: 0, y: 0 };
      uiPositions.set(id, pos);
    }
  }

  const linearData = parseLinearData(input.workflow);
  const hasLinear = Boolean(linearData?.inputs.length);
  const linearKeys = new Set(
    (linearData?.inputs ?? []).map((item) => `${item.nodeId}.${item.widgetName}`),
  );

  const fields: Field[] = [];
  const warnings = [...input.warnings];
  const fieldByKey = new Map<string, Field>();
  let sequence = 0;

  const promptIds = Object.keys(prompt);
  const nodeOrder = [...promptIds].sort((a, b) => {
    const pa = uiPositions.get(a);
    const pb = uiPositions.get(b);
    if (pa && pb && (pa.y !== pb.y || pa.x !== pb.x)) {
      return pa.y - pb.y || pa.x - pb.x;
    }
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return promptIds.indexOf(a) - promptIds.indexOf(b);
  });

  for (const nodeId of nodeOrder) {
    const node = prompt[nodeId];
    if (!node || typeof node.class_type !== 'string') continue;
    if (SKIP_CLASS_TYPES.has(node.class_type)) continue;
    const uiNode = uiNodes.get(nodeId);
    const rawTitle =
      (typeof uiNode?.title === 'string' && uiNode.title) ||
      (typeof node._meta?.title === 'string' && node._meta.title) ||
      node.class_type;
    const marker = parseMarker(rawTitle);
    if (marker.hidden) continue;

    const def = getDefinition(objectInfo, node.class_type);
    const inputEntries = Object.entries(node.inputs ?? {});
    for (let inputIndex = 0; inputIndex < inputEntries.length; inputIndex += 1) {
      const [inputName, value] = inputEntries[inputIndex]!;
      if (inputName === 'control_after_generate') continue;
      if (isLinkRef(value, prompt)) continue;
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) continue;
      if (value && typeof value === 'object') continue;

      const spec = getInputSpec(def, inputName);
      const options = comboOptions(spec?.type, spec?.cfg);
      if (spec && !options && !isWidgetSpec(spec)) continue;

      const inferredGroup = marker.group ?? groupFor(node.class_type, inputName);
      const kind = kindFor(node.class_type, inputName, spec, value, marker, options);
      const constraints = constraintsFor(kind, spec, value, options, marker);
      const key = `${nodeId}.${inputName}`;
      if (fieldByKey.has(key)) continue;
      const usesLinear = hasLinear && linearKeys.has(key);
      const field: Field = {
        key,
        nodeId,
        input: inputName,
        widgetName: inputName,
        kind,
        label: labelFor(node.class_type, inputName, rawTitle, marker),
        description: marker.label && inputName === 'text' ? undefined : undefined,
        group: inferredGroup,
        order: sequence * 10,
        required: spec?.required ?? false,
        default: value,
        constraints,
        visible: marker.exposed || usesLinear || !hasLinear,
        advanced: inferredGroup === 'advanced' && !usesLinear && !marker.exposed,
        source: marker.exposed ? 'marker' : usesLinear ? 'linear' : 'heuristic',
      };
      sequence += 1;
      fields.push(field);
      fieldByKey.set(key, field);
    }
  }

  if (linearData?.inputs.length) {
    const before = new Set(fields.map((field) => field.key));
    mergeLinearFields(fields, linearData.inputs, warnings);
    for (const field of fields) {
      if (!field.visible && field.source === 'linear') field.visible = true;
    }
    const matched = fields.filter((field) => field.source === 'linear').length;
    if (matched !== linearData.inputs.length) {
      const unmatched = linearData.inputs.length - matched;
      if (unmatched > 0) {
        warnings.push(`App Builder 中有 ${unmatched} 个参数未匹配到可执行节点`);
      }
    }
    for (const key of linearKeys) {
      if (!before.has(key) && !fields.some((field) => field.key === key)) {
        // A linear input may use a subgraph-internal id; the per-node suffix
        // matching above reports the useful warning.
      }
    }
  } else {
    for (const field of fields) {
      if (!field.visible) field.visible = true;
    }
  }

  // Explicit overrides always win, including visibility, labels, groups and
  // control types.
  const staleOverrides: string[] = [];
  if (overrides?.fields?.length) {
    const overrideByKey = new Map(overrides.fields.map((item) => [item.key, item]));
    for (const override of overrides.fields) {
      const field = fieldByKey.get(override.key);
      if (!field) {
        staleOverrides.push(override.key);
        continue;
      }
      if (override.label !== undefined) field.label = override.label;
      if (override.description !== undefined) field.description = override.description;
      if (override.kind !== undefined) {
        field.kind = override.kind;
        if (override.kind === 'seed') {
          field.constraints.min = 0;
          field.constraints.max = 4_294_967_295;
          field.constraints.step = 1;
          field.constraints.integer = true;
        }
      }
      if (override.group !== undefined) field.group = override.group;
      if (override.order !== undefined) field.order = override.order;
      if (override.visible !== undefined) field.visible = override.visible;
      if (override.advanced !== undefined) field.advanced = override.advanced;
      field.overridden = true;
    }
    // Keep any override entries in their intended order even if they came from
    // older forms that only listed a subset.
    for (const [key, override] of overrideByKey) {
      const field = fieldByKey.get(key);
      if (field && override.order === undefined) field.order = field.order * 10 + 1;
    }
  }

  // Stable ordering: explicit order first, then source-ish order, then key.
  fields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key, 'en'));
  fields.forEach((field, index) => {
    field.order = index;
  });

  const groupMap = new Map<string, FieldGroup>();
  for (const group of DEFAULT_GROUPS) groupMap.set(group.id, { ...group });
  for (const field of fields) {
    if (!groupMap.has(field.group)) {
      groupMap.set(field.group, {
        id: field.group,
        label: field.group,
        order: 80 + groupMap.size,
      });
    }
  }
  const groups = [...groupMap.values()]
    .filter((group) => fields.some((field) => field.group === group.id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  return {
    fields,
    groups,
    warnings: [...new Set(warnings)],
    staleOverrides,
  };
}

function isWidgetSpec(spec: InputSpec): boolean {
  const type = typeName(spec.type, spec.cfg);
  if (!type) return false;
  const parts = type.split(',').map((part) => part.trim());
  return parts.every(
    (part) => part === 'INT' || part === 'FLOAT' || part === 'STRING' || part === 'BOOLEAN' || part === 'COMBO',
  );
}
