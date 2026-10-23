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

export interface NodeDefinition {
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

export interface InputSpec {
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
  prompt: '提示词',
  positive_prompt: '正向提示词',
  negative_prompt: '反向提示词',
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
  positive: '正向提示词',
  negative: '反向提示词',
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

const PROMPT_CLASSES = new Set([
  'CLIPTextEncode',
  'CLIPTextEncodeSDXL',
  'CLIPTextEncodeSDXLRefiner',
  'BNK_CLIPTextEncodeAdvanced',
]);

const PROMPT_INPUTS = new Set([
  'text',
  'prompt',
  'positive',
  'positive_prompt',
  'negative',
  'negative_prompt',
]);

const PROMPT_TITLE = /提示词|prompt|正向|反向|负面|positive|negative|主体描述|画面描述/i;
const PROMPT_ENHANCER_CLASS =
  /prompt.?enhanc|enhancer|llm.?provider|ollama|openai|textgen|text.?generate|chat.?completion/i;
// Titles that look like an enhancer's system instruction rather than the
// prompt the user actually wants to type.
const PROMPT_SYSTEM_TITLE = /系统|指令|规则|模板|改写|enhanc|system|instruction|template/i;
const IMAGE_INPUT =
  /^(images?|mask|video|input_image|start_image|end_image|reference_image|ref_image|source_image|image_?\d+)$/;

const MODEL_INPUTS = new Set(['ckpt_name', 'unet_name']);
const LORA_INPUTS = new Set(['lora_name', 'strength_model', 'strength_clip']);
const CLIP_INPUTS = new Set([
  'clip_name',
  'clip_name1',
  'clip_name2',
  'clip_name3',
  'clip_vision',
  'stop_at_clip_layer',
  'clip_skip',
]);
const VAE_INPUTS = new Set(['vae_name']);

// Everything that changes the generated result without touching the model
// stack: sampling, guidance and canvas/video shape.
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
  'width',
  'height',
  'batch_size',
  'megapixels',
  'resolution',
  'aspect_ratio',
  'length',
  'frames',
  'num_frames',
  'video_length',
  'frame_rate',
  'fps',
]);

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function getDefinition(
  objectInfo: Record<string, unknown>,
  classType: string,
): NodeDefinition | undefined {
  const def = objectInfo[classType];
  return def && typeof def === 'object' ? (def as NodeDefinition) : undefined;
}

export function getInputSpec(def: NodeDefinition | undefined, input: string): InputSpec | undefined {
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

export function isLinkRef(value: unknown, prompt: ApiPrompt): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const [source, slot] = value;
  if (typeof slot !== 'number' || !Number.isInteger(slot)) return false;
  if (typeof source !== 'string' && typeof source !== 'number') return false;
  return Object.prototype.hasOwnProperty.call(prompt, String(source));
}

/** Loaders that only supply a media file; cancelling one bypasses the node. */
const MEDIA_SLOT_SOURCE =
  /^(?:LoadImage|LoadImageMask|LoadImageOutput|LoadVideo|LoadAudio|VHS_Load\w*|ImageInput)$/;

/** The widget on a media loader that holds the file reference. */
const MEDIA_SLOT_INPUT = /^(?:image|images|video|audio|file|filename|input_image|mask)$/i;

export function promptIdsFor(prompt: ApiPrompt, nodeId: string): string[] {
  if (Object.prototype.hasOwnProperty.call(prompt, nodeId)) return [nodeId];
  const suffix = `:${nodeId}`;
  const ids = Object.keys(prompt).filter((key) => key.endsWith(suffix));
  return ids.length === 1 ? ids : [];
}

function typeNames(type: unknown): string[] {
  if (Array.isArray(type)) return ['COMBO'];
  if (typeof type !== 'string') return [];
  return type
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Types of the node's connected inputs, i.e. what a bypass can pass through. */
function passThroughTypes(
  def: NodeDefinition | undefined,
  node: ApiPrompt[string],
  prompt: ApiPrompt,
): string[] {
  const types = new Set<string>();
  for (const [inputName, value] of Object.entries(node.inputs ?? {})) {
    if (!isLinkRef(value, prompt)) continue;
    for (const type of typeNames(getInputSpec(def, inputName)?.type)) types.add(type);
  }
  return [...types];
}

/**
 * A node may be bypassed when dropping it cannot invalidate a required input:
 * every required consumer link has a same-typed linked input on the bypassed
 * node that ComfyUI can pass through (the rule ComfyUI's bypass mode follows).
 */
function nodeBypassable(
  prompt: ApiPrompt,
  objectInfo: Record<string, unknown>,
  nodeId: string,
): boolean {
  const ids = promptIdsFor(prompt, nodeId);
  if (ids.length !== 1) return false;
  const actualId = ids[0]!;
  const node = prompt[actualId]!;
  const def = getDefinition(objectInfo, node.class_type);
  if (!def?.output?.length) return false;
  const available = new Set(passThroughTypes(def, node, prompt));
  const suffix = `:${nodeId}`;
  for (const [consumerId, consumer] of Object.entries(prompt)) {
    if (consumerId === actualId) continue;
    const consumerDef = getDefinition(objectInfo, consumer.class_type);
    for (const [inputName, value] of Object.entries(consumer.inputs ?? {})) {
      if (!isLinkRef(value, prompt)) continue;
      const source = String((value as unknown[])[0]);
      if (source !== actualId && source !== nodeId && !source.endsWith(suffix)) continue;
      const spec = getInputSpec(consumerDef, inputName);
      if (!spec) return false;
      if (!spec.required) continue;
      const wanted = typeNames(spec.type);
      if (!wanted.length || !wanted.some((type) => available.has(type))) return false;
    }
  }
  return true;
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

function isGenericNodeTitle(title: string, classType: string): boolean {
  if (!title.trim()) return true;
  return title === classType || /^[A-Za-z0-9_]+$/.test(title);
}

/**
 * Node titles are often preset summaries such as
 * "Krea 官方：euler / simple / 8步 / CFG 1". Only the leading context is
 * useful on a phone form; the rest is stale the moment a parameter changes.
 */
function nodeContextFor(title: string, classType: string): string | undefined {
  const cleaned = title.trim();
  if (!cleaned || isGenericNodeTitle(cleaned, classType)) return undefined;
  const [prefix] = cleaned.split(/[：:]/);
  const context = prefix?.trim() ?? '';
  if (context && context.length <= 20) return context;
  if (cleaned.length <= 16) return cleaned;
  return undefined;
}

/**
 * True for the node holding the prompt the user actually types. Prompt text
 * travels through many node types (CLIPTextEncode, CR Prompt Text,
 * PrimitiveStringMultiline, custom encoders) and input names vary.
 */
function isPromptField(classType: string, input: string, title: string): boolean {
  if (PROMPT_ENHANCER_CLASS.test(classType)) return false;
  if (PROMPT_CLASSES.has(classType)) return true;
  if (PROMPT_INPUTS.has(input)) return true;
  return (
    /PrimitiveStringMultiline|String Multiline|Text Multiline/i.test(classType) &&
    input === 'value' &&
    PROMPT_TITLE.test(title) &&
    !PROMPT_SYSTEM_TITLE.test(title)
  );
}

/**
 * Place a widget into a themed section. Order matters: asset loaders and
 * prompt encoders are recognised before the generic model/CLIP/VAE rules so a
 * `CLIPTextEncode.text` stays under 提示词 and a `LoadVideo` stays under 素材.
 */
function groupFor(classType: string, input: string, title = ''): string {
  if (
    /(?:^|[_\s-])(?:save|preview|combine)(?:[_\s-]|$)|Save(?:Image|Video|Animated|Latent|Audio)|Preview(?:Image|Video|Audio|Any)|VideoCombine/i.test(
      classType,
    ) ||
    input === 'filename_prefix'
  ) {
    return 'output';
  }
  if (
    /LoadImage|LoadImageMask|LoadImageOutput|LoadVideo|VHS_Load|ImageInput/i.test(classType) ||
    IMAGE_INPUT.test(input)
  ) {
    return 'image';
  }
  // LLM prompt-enhancement nodes (T8, Ollama, OpenAI, ...) have a lot of
  // tuning widgets; keep them together in a collapsed section of their own.
  // Checked before the generic prompt rules so their internal `prompt`
  // widgets do not leak into the main 提示词 section.
  if (PROMPT_ENHANCER_CLASS.test(classType)) return 'prompt_enhance';
  if (isPromptField(classType, input, title)) return 'prompt';
  // Resize nodes carry width/height too; keep their widgets together instead
  // of splitting them into 生成参数.
  if (/upscale|resize|esrgan|swinir|realesrgan|image.?scale/i.test(classType)) {
    return 'upscale';
  }
  if (SAMPLING_INPUTS.has(input) || /Sampler|Guider|Scheduler|Noise/i.test(classType)) {
    return 'sampling';
  }
  if (/lora/i.test(classType) || LORA_INPUTS.has(input)) return 'lora';
  if (/clip/i.test(classType) || CLIP_INPUTS.has(input)) return 'clip';
  if (/vae/i.test(classType) || VAE_INPUTS.has(input)) return 'vae';
  if (/controlnet|ipadapter|instantid|pulid|redux|faceid|conditioning/i.test(classType)) {
    return 'conditioning';
  }
  if (/video|animatediff|framepack|\bsvd\b|interpolat/i.test(classType)) return 'video';
  if (/audio|music|tts|vocoder|ace.?step/i.test(classType)) return 'audio';
  if (MODEL_INPUTS.has(input) || /checkpoint|unet|model.?loader/i.test(classType)) {
    return 'model';
  }
  return 'advanced';
}

function labelFor(
  classType: string,
  input: string,
  title: string,
  marker: MarkerInfo,
): string {
  const cleanTitle = marker.cleanTitle || title;
  const lowerTitle = cleanTitle.toLowerCase();
  if (isPromptField(classType, input, cleanTitle)) {
    if (/negative|反向|负面|负条件/.test(`${input} ${lowerTitle}`)) return '反向提示词';
    if (/positive|正向|正面|正条件/.test(`${input} ${lowerTitle}`)) return '正向提示词';
    if (marker.label) return marker.label;
    if (!isGenericNodeTitle(cleanTitle, classType)) return cleanTitle;
    return '提示词';
  }
  // The node title is preset metadata, not the field's name. Show it as a
  // small context line instead of repeating it in every label.
  return marker.label ?? translatedInputLabel(input);
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

/** Groups where the node title adds useful context to short field labels. */
const CONTEXT_GROUPS = new Set([
  'sampling',
  'model',
  'lora',
  'clip',
  'vae',
  'conditioning',
  'upscale',
  'advanced',
]);

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
    const nodeTitle = nodeContextFor(marker.cleanTitle || rawTitle, node.class_type);

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

      const inferredGroup =
        marker.group ?? groupFor(node.class_type, inputName, marker.cleanTitle || rawTitle);
      const kind = kindFor(node.class_type, inputName, spec, value, marker, options);
      const constraints = constraintsFor(kind, spec, value, options, marker);
      const key = `${nodeId}.${inputName}`;
      if (fieldByKey.has(key)) continue;
      const usesLinear = hasLinear && linearKeys.has(key);
      const field: Field = {
        key,
        nodeId,
        nodeClass: node.class_type,
        input: inputName,
        widgetName: inputName,
        kind,
        label: labelFor(node.class_type, inputName, rawTitle, marker),
        nodeTitle: CONTEXT_GROUPS.has(inferredGroup) ? nodeTitle : undefined,
        description: marker.label && inputName === 'text' ? undefined : undefined,
        group: inferredGroup,
        order: sequence * 10,
        required: spec?.required ?? false,
        default: value,
        constraints,
        // Prompt and reference-image slots are the two things every workflow
        // needs on a phone, so keep them even when App Builder omitted them.
        visible:
          marker.exposed ||
          usesLinear ||
          !hasLinear ||
          inferredGroup === 'prompt' ||
          inferredGroup === 'image',
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

  // Group-aware ordering keeps the phone form in the same order as the
  // sections: prompt → reference images → generation → model stack → rest.
  const groupOrder = new Map<string, number>(
    DEFAULT_GROUPS.map((group) => [group.id, group.order]),
  );
  for (const field of fields) {
    if (!groupOrder.has(field.group)) groupOrder.set(field.group, 80 + groupOrder.size);
  }
  const promptRank = (field: Field): number => {
    const text = `${field.input} ${field.label}`;
    if (/negative|反向|负面|负条件/i.test(text)) return 2;
    if (/positive|正向|正面|正条件/i.test(text)) return 0;
    return 1;
  };
  fields.sort((a, b) => {
    const groupDiff = (groupOrder.get(a.group) ?? 80) - (groupOrder.get(b.group) ?? 80);
    if (groupDiff !== 0) return groupDiff;
    if (a.group === 'prompt') {
      const rankDiff = promptRank(a) - promptRank(b);
      if (rankDiff !== 0) return rankDiff;
    }
    return a.order - b.order || a.key.localeCompare(b.key, 'en');
  });
  fields.forEach((field, index) => {
    field.order = index;
  });

  // Short labels ("采样器", "步数") can repeat when several nodes of the same
  // kind are exposed. Only then add the node context back to tell them apart.
  const labelCounts = new Map<string, number>();
  for (const field of fields) {
    if (!field.visible || field.group === 'prompt') continue;
    const labelKey = `${field.group}\u0000${field.label}`;
    labelCounts.set(labelKey, (labelCounts.get(labelKey) ?? 0) + 1);
  }
  for (const field of fields) {
    if (!field.visible || field.group === 'prompt') continue;
    const labelKey = `${field.group}\u0000${field.label}`;
    if ((labelCounts.get(labelKey) ?? 0) < 2) continue;
    field.label = `${field.label}（${field.nodeTitle ?? `节点 ${field.nodeId}`}）`;
  }

  // Number reference-image slots so a multi-image upload maps to an obvious
  // order (图片 #1, #2, ...).
  const imageFields = fields.filter(
    (field) => field.group === 'image' && field.kind === 'image' && field.visible,
  );
  if (imageFields.length > 1) {
    imageFields.forEach((field, index) => {
      field.label = `${field.label} #${index + 1}`;
    });
  }

  // Media loader slots (image/video/audio) can always be cancelled: the slot
  // is bypassed, so a user may pass fewer reference files than the saved
  // workflow did, even when a consumer marks the input required. Other nodes
  // can be bypassed when their required consumers all have a matching
  // pass-through input.
  const bypassCache = new Map<string, boolean>();
  for (const field of fields) {
    if (MEDIA_SLOT_SOURCE.test(field.nodeClass ?? '')) {
      field.skippable = field.kind === 'image' || MEDIA_SLOT_INPUT.test(field.input);
      continue;
    }
    let bypassable = bypassCache.get(field.nodeId);
    if (bypassable === undefined) {
      bypassable = nodeBypassable(prompt, objectInfo, field.nodeId);
      bypassCache.set(field.nodeId, bypassable);
    }
    field.nodeBypassable = bypassable;
  }

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
