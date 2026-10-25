import type {
  Field,
  FieldConstraints,
  FieldGroup,
  FieldKind,
  FieldOption,
  FieldTier,
  FormOverrides,
  WorkflowSummary,
} from '@comfy-mobile/shared';
import { DEFAULT_GROUPS, FIELD_TIERS } from '@comfy-mobile/shared';
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
  ratio: '画幅比例',
  duration: '时长',
  duration_seconds: '时长',
  seconds: '时长',
  frame_rate: '帧率',
  fps: '帧率',
  frames: '帧数',
  frame_count: '帧数',
  length: '长度',
  video_length: '视频长度',
  bit_depth: '位深',
  color_space: '色彩空间',
  format: '格式',
  codec: '编码器',
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
  'ratio',
  'length',
  'frames',
  'num_frames',
  'frame_count',
  'video_length',
  'frame_rate',
  'fps',
  'duration',
  'duration_seconds',
  'seconds',
  'video_duration',
  'clip_duration',
]);

/** Inputs that describe the output shape; shown first in 生成参数. */
const SHAPE_INPUT =
  /^(resolution|aspect_ratio|ratio|megapixels|width|height)$/i;

/** Timing inputs (时长 / 帧数 / 帧率) sit next to the shape inputs. */
const TIMING_INPUT =
  /^(duration|duration_seconds|seconds|video_duration|clip_duration|length|video_length|frames|num_frames|frame_count|frame_rate|fps)$/i;

/**
 * V3 dynamic combos expose nested leaves as dotted keys (`model.duration`).
 * Everything user-facing (labels, groups, control kinds) should key off the
 * leaf, while the field key keeps the full dotted name for patching.
 */
function leafInput(input: string): string {
  const dot = input.lastIndexOf('.');
  return dot >= 0 && dot < input.length - 1 ? input.slice(dot + 1) : input;
}

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
  if (required !== undefined) return inputSpec(required, true);
  const optional = def?.input?.optional?.[input];
  if (optional !== undefined) return inputSpec(optional, false);
  return undefined;
}

function inputSpec(raw: unknown, required: boolean): InputSpec {
  const spec = raw as unknown[];
  return {
    type: Array.isArray(spec) ? spec[0] : spec,
    cfg: asRecord(Array.isArray(spec) ? spec[1] : undefined),
    required,
  };
}

interface InputBag {
  required?: Record<string, unknown>;
  optional?: Record<string, unknown>;
}

function nestedInputBag(option: JsonRecord | undefined): InputBag | undefined {
  const inputs = asRecord(option?.inputs);
  if (!inputs) return undefined;
  return {
    required: asRecord(inputs.required),
    optional: asRecord(inputs.optional),
  };
}

/**
 * Resolve a widget spec by name, including V3 dynamic-combo leaves.
 *
 * Nested leaves are addressed with dotted keys (`model.duration`), but
 * object_info keeps their specs inside the SELECTED option of the parent combo:
 *
 *   model: ["COMFY_DYNAMICCOMBO_V3", { options: [
 *     { key: "MiniMax H3", inputs: { required: { duration: ["INT", {...}] } } }
 *   ]}]
 *
 * Looking only at the top level would leave those leaves spec-less: enums turn
 * into free-text boxes (ComfyUI then rejects them with "Value not in list"),
 * numeric bounds disappear, and multiline prompts render as single-line inputs.
 */
export function resolveInputSpec(
  def: NodeDefinition | undefined,
  inputs: Record<string, unknown> | undefined,
  inputName: string,
): InputSpec | undefined {
  // Some servers/exporters materialise nested leaves as literal dotted keys.
  const direct = getInputSpec(def, inputName);
  if (direct) return direct;
  let bag: InputBag = {
    required: def?.input?.required,
    optional: def?.input?.optional,
  };
  const parts = inputName.split('.');
  let raw: unknown = undefined;
  let required = false;
  for (let index = 0; index < parts.length; index += 1) {
    const name = parts[index]!;
    const requiredValue = bag.required?.[name];
    const optionalValue = bag.optional?.[name];
    raw = requiredValue !== undefined ? requiredValue : optionalValue;
    required = requiredValue !== undefined;
    if (raw === undefined) return undefined;
    if (index === parts.length - 1) break;
    // Walk into the parent dynamic combo's currently selected option.
    const cfg = Array.isArray(raw) ? asRecord(raw[1]) : undefined;
    const options = cfg?.options;
    if (!Array.isArray(options)) return undefined;
    const selectedKey = inputs?.[parts.slice(0, index + 1).join('.')];
    if (selectedKey === undefined) return undefined;
    const selected = options.find((option) => {
      const record = asRecord(option);
      return record?.key !== undefined && String(record.key) === String(selectedKey);
    });
    const next = nestedInputBag(asRecord(selected));
    if (!next) return undefined;
    bag = next;
  }
  return inputSpec(raw, required);
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
    let rawValue: string | number | boolean | undefined;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      rawValue = item;
      value = String(item);
      label = value;
    } else {
      const record = asRecord(item);
      if (!record) continue;
      const declared = record.key ?? record.value ?? record.id ?? record.name;
      if (
        typeof declared !== 'string' &&
        typeof declared !== 'number' &&
        typeof declared !== 'boolean'
      ) {
        continue;
      }
      rawValue = declared;
      value = String(declared);
      const rawLabel = record.label ?? record.display_name ?? record.name ?? value;
      label = typeof rawLabel === 'string' ? rawLabel : value;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    options.push(
      rawValue === value
        ? { value, label: label || value }
        : { value, label: label || value, rawValue },
    );
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
    for (const type of typeNames(resolveInputSpec(def, node.inputs, inputName)?.type)) {
      types.add(type);
    }
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
      const spec = resolveInputSpec(consumerDef, consumer.inputs, inputName);
      if (!spec) return false;
      if (!spec.required) continue;
      const wanted = typeNames(spec.type);
      if (!wanted.length || !wanted.some((type) => available.has(type))) return false;
    }
  }
  return true;
}

/**
 * A media loader can be cancelled only when every consumer treats the linked
 * input as optional. Dropping a link that a consumer declares as required
 * makes ComfyUI reject the whole prompt with "Required input is missing", so
 * the slot must stay mandatory instead.
 */
function mediaSlotSkippable(
  prompt: ApiPrompt,
  objectInfo: Record<string, unknown>,
  nodeId: string,
): boolean {
  const ids = promptIdsFor(prompt, nodeId);
  if (ids.length !== 1) return false;
  const actualId = ids[0]!;
  const suffix = `:${nodeId}`;
  for (const [consumerId, consumer] of Object.entries(prompt)) {
    if (consumerId === actualId) continue;
    const def = getDefinition(objectInfo, consumer.class_type);
    for (const [inputName, value] of Object.entries(consumer.inputs ?? {})) {
      if (!isLinkRef(value, prompt)) continue;
      const source = String((value as unknown[])[0]);
      if (source !== actualId && source !== nodeId && !source.endsWith(suffix)) continue;
      if (resolveInputSpec(def, consumer.inputs, inputName)?.required) return false;
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

const DURATION_PRIMITIVE_CLASS = /^Primitive(?:Float|Int|Number|String)$/;
const DURATION_TITLE = /duration|时长|秒数|秒|seconds?|clip\s*length|视频长度/i;

/**
 * `PrimitiveFloat` titled "Float (duration)" is how the video templates expose
 * a seconds-based length. Its `value` widget is the 时长 control.
 */
function isDurationPrimitive(classType: string, input: string, title: string): boolean {
  return (
    input === 'value' &&
    DURATION_PRIMITIVE_CLASS.test(classType) &&
    DURATION_TITLE.test(title)
  );
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

/** Groups that belong to the "adjust if you know why" tier. */
const TUNING_GROUPS = new Set(['sampling', 'conditioning']);

/** Loader groups rendered as one independent card each under 模型加载. */
const MODEL_GROUPS = new Set(['model', 'clip', 'vae', 'lora']);

/** Everything whose defaults are normally kept: codecs, output, helpers. */
const ADVANCED_GROUPS = new Set([
  'upscale',
  'video',
  'audio',
  'output',
  'prompt_enhance',
  'advanced',
]);

/**
 * Rank a field by how often a user touches it on a phone. Inputs (prompt and
 * media) are always needed, output shape is confirmed per run, the model stack
 * is switched for comparison, sampling knobs are optional, and the encoding
 * details should stay collapsed.
 */
function tierFor(field: Pick<Field, 'group' | 'kind' | 'input' | 'label'>): FieldTier {
  if (field.group === 'prompt' || field.group === 'image') return 'input';
  if (field.kind === 'image') return 'input';
  // Checkpoint, CLIP, VAE and LoRA loaders form their own step so switching a
  // model never means digging through the advanced parameters.
  if (MODEL_GROUPS.has(field.group)) return 'model';
  // Scaling utilities resize a reference image or post-process a result; they
  // are not the run's output shape, so keep their megapixels/width knobs out
  // of 输出规格 (they would otherwise sit next to the real resolution picker).
  if (field.group === 'upscale') return 'tuning';
  const input = leafInput(field.input);
  // Only the output writer's own timing widgets (frame rate, length) count as
  // run output. A prompt enhancer's "target duration" and similar helper
  // nodes stay with the rest of their group.
  const helperGroup = ADVANCED_GROUPS.has(field.group) && field.group !== 'output';
  if (!helperGroup) {
    // `resolution` is ambiguous: on a dynamic video model it is the output
    // tier (a combo such as 768P/2K), while on an encoder it often just
    // resizes reference images. Keep only the combo form as output shape.
    const shape =
      /^(aspect_ratio|ratio|megapixels|width|height)$/i.test(input) ||
      (input === 'resolution' && field.kind === 'select');
    if (shape || TIMING_INPUT.test(input)) return 'output';
    // "分辨率" on a number widget is usually a helper pixel size (e.g. how the
    // encoder downsizes reference images), not the run's output shape.
    if (/画幅比例|时长|帧数|帧率/.test(field.label)) return 'output';
    if (field.kind === 'select' && /分辨率/.test(field.label)) return 'output';
  }
  if (ADVANCED_GROUPS.has(field.group)) return 'advanced';
  if (TUNING_GROUPS.has(field.group)) return 'tuning';
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
  // The length cap is a guard on new input, not a judgement on the workflow's
  // own content: long fixed prompts (Qwen/Flux pipelines routinely embed them)
  // are legitimate. A cap below the saved value would reject the untouched
  // field at run time, so it can never be the smaller of the two.
  if (typeof value === 'string' && constraints.maxLength !== undefined) {
    constraints.maxLength = Math.max(constraints.maxLength, value.length);
  }
  if (kind === 'select' && !constraints.options) constraints.options = [];
  return constraints;
}

function visibleByDefault(group: string): boolean {
  return true;
}

/**
 * API-format workflows skip the converter, so their combo values are never
 * checked against object_info. A stale enum (a sampler removed by an upgrade)
 * then fails at queue time with ComfyUI's opaque "Value not in list". Mirror
 * the converter's policy here: substitute the first valid enum and warn, but
 * never silently swap a model/file selector.
 */
const ASSET_INPUT =
  /^(?:ckpt_name|unet_name|lora_name|vae_name|clip_name\d*|control_net_name|model_name|model|embedding|style_model_name|ipadapter)$/i;
const ASSET_VALUE = /\.(?:safetensors|sft|ckpt|pt|pt2|pth|bin|gguf|onnx|vae|pkl)$/i;

function isAssetSelector(field: Field, value: unknown): boolean {
  const leaf = leafInput(field.input);
  return ASSET_INPUT.test(leaf) || ASSET_VALUE.test(String(value));
}

function validateComboDefault(field: Field, warnings: string[]): void {
  if (field.kind !== 'select') return;
  const options = field.constraints.options;
  if (!options) return;
  const value = field.default;
  if (value === undefined || value === null || value === '') return;
  if (options.some((option) => option.value === String(value))) return;
  const node = `Node ${field.nodeId} (${field.nodeClass ?? 'unknown'})`;
  const widget = leafInput(field.input);
  if (!options.length) {
    warnings.push(
      isAssetSelector(field, value)
        ? `${node}: widget "${widget}" value "${String(value)}" — the connected server has no installed options for this asset combo; keeping the declared value so it surfaces as a missing-asset error.`
        : `${node}: widget "${widget}" value "${String(value)}" — the connected server lists no options for this combo, so it cannot be validated; keeping the declared value so it surfaces as an honest error rather than being silently emitted.`,
    );
    return;
  }
  if (isAssetSelector(field, value)) {
    warnings.push(
      `${node}: widget "${widget}" value "${String(value)}" is not installed on the connected server — keeping the declared value so it surfaces as a missing-asset error rather than silently substituting "${options[0]!.value}".`,
    );
    return;
  }
  const replacement = options[0]!.rawValue ?? options[0]!.value;
  warnings.push(
    `${node}: widget "${widget}" value "${String(value)}" is not a valid option on the connected server — substituting the first available option "${String(replacement)}" so the graph stays runnable (ComfyUI rejects unknown enum values).`,
  );
  field.default = replacement;
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
  // ComfyUI writes the locale's display name for each widget into the UI
  // workflow. Two nodes can share a widget name (`megapixels`) but name it
  // differently here ("百万像素" vs "像素数量"), which is exactly what the
  // duplicate-label fallback needs.
  const uiInputLabels = new Map<string, string>();
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
      if (!Array.isArray(node.inputs)) continue;
      for (const rawInput of node.inputs) {
        const input = asRecord(rawInput);
        const name = input?.name;
        const label = input?.localized_name;
        if (typeof name !== 'string' || typeof label !== 'string') continue;
        const cleaned = label.trim();
        if (!cleaned || cleaned === name) continue;
        uiInputLabels.set(`${id}.${name}`, cleaned);
      }
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

      const spec = resolveInputSpec(def, node.inputs, inputName);
      const options = comboOptions(spec?.type, spec?.cfg);
      if (spec && !options && !isWidgetSpec(spec)) continue;

      const leaf = leafInput(inputName);
      const titleText = marker.cleanTitle || rawTitle;
      // `Float (duration)` style primitives drive video length through an
      // expression node. Treat them as the 时长 control instead of leaving an
      // anonymous "Value" buried in 高级.
      const durationPrimitive = isDurationPrimitive(node.class_type, leaf, titleText);
      const inferredGroup =
        marker.group ??
        (durationPrimitive ? 'sampling' : groupFor(node.class_type, leaf, titleText));
      const kind = kindFor(node.class_type, leaf, spec, value, marker, options);
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
        label: durationPrimitive
          ? marker.label ?? '时长'
          : labelFor(node.class_type, leaf, rawTitle, marker),
        nodeTitle: durationPrimitive
          ? undefined
          : CONTEXT_GROUPS.has(inferredGroup)
            ? nodeTitle
            : undefined,
        description: marker.label && inputName === 'text' ? undefined : undefined,
        group: inferredGroup,
        tier: 'advanced',
        order: sequence * 10,
        required: spec?.required ?? false,
        default: value,
        constraints,
        // Without App Builder data the default set is decided after tiers are
        // known (see below), so only explicit markers and linear inputs opt in
        // here.
        visible: marker.exposed || usesLinear || (hasLinear && (inferredGroup === 'prompt' || inferredGroup === 'image')),
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
    // ComfyUI is where a workflow is built; this app only invokes it. Without
    // an explicit App Builder field list, keep the form to what a run needs:
    // prompt/reference media and the output shape. Everything else keeps the
    // workflow's saved value and is revealed only on request.
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

  // Explicit overrides can move a field to another group, so tiers are derived
  // after they are applied.
  for (const field of fields) {
    field.tier = tierFor(field);
  }

  // No App Builder field list: expose only the must-fill inputs and the
  // per-run output shape, and park the rest behind "更多参数". They still
  // carry the saved workflow value, so runs stay faithful without asking the
  // user to understand every node.
  if (!hasLinear) {
    for (const field of fields) {
      if (field.overridden || field.source === 'marker') continue;
      const primary =
        field.tier === 'input' || field.tier === 'output' || field.tier === 'model';
      field.visible = primary;
      field.more = !primary;
    }
  }

  // Model loading is a first-class step of the run form: switching the
  // checkpoint or toggling a LoRA is how people compare results without
  // editing the workflow. Keep those controls reachable even when an App
  // Builder field list omitted them; an explicit override can still hide one.
  for (const field of fields) {
    if (field.tier === 'model' && !field.overridden) field.visible = true;
  }

  // Validate every field the form may send, including hidden ones revealed
  // later: a stale enum default must not make a run fail on an untouched node.
  for (const field of fields) {
    if (field.visible || field.more) validateComboDefault(field, warnings);
  }

  // Group-aware ordering keeps the phone form in the same order as the
  // sections: prompt → reference images → generation → model stack → rest.
  const groupOrder = new Map<string, number>(
    DEFAULT_GROUPS.map((group) => [group.id, group.order]),
  );
  const tierOrder = new Map<string, number>(
    FIELD_TIERS.map((tier) => [tier.id, tier.order]),
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
  // Inside 生成参数, output shape (分辨率/画幅) and timing (时长/帧数/帧率) come
  // before seeds and sampler tuning: those are what people change per clip.
  const samplingRank = (field: Field): number => {
    const input = leafInput(field.input);
    if (SHAPE_INPUT.test(input) || /分辨率|画幅比例/.test(field.label)) return 0;
    // Duration primitives carry the semantic in their label ("时长"), not in
    // their input name (`value`).
    if (TIMING_INPUT.test(input) || /时长|帧数|帧率/.test(field.label)) return 1;
    return 2;
  };
  fields.sort((a, b) => {
    const tierDiff =
      (tierOrder.get(a.tier ?? 'advanced') ?? 90) -
      (tierOrder.get(b.tier ?? 'advanced') ?? 90);
    if (tierDiff !== 0) return tierDiff;
    // Inside 输出规格, shape (分辨率/画幅) comes before timing (时长/帧数/帧率).
    if (a.tier === 'output') {
      const rankDiff = samplingRank(a) - samplingRank(b);
      if (rankDiff !== 0) return rankDiff;
    }
    const groupDiff = (groupOrder.get(a.group) ?? 80) - (groupOrder.get(b.group) ?? 80);
    if (groupDiff !== 0) return groupDiff;
    if (a.group === 'prompt') {
      const rankDiff = promptRank(a) - promptRank(b);
      if (rankDiff !== 0) return rankDiff;
    }
    if (a.group === 'sampling') {
      const rankDiff = samplingRank(a) - samplingRank(b);
      if (rankDiff !== 0) return rankDiff;
    }
    return a.order - b.order || a.key.localeCompare(b.key, 'en');
  });
  fields.forEach((field, index) => {
    field.order = index;
  });

  // Short labels ("采样器", "步数", "百万像素") can repeat when several nodes
  // are exposed. Compare across the whole form, not per group: two
  // `megapixels` widgets on different nodes (generation size vs. reference
  // image scaling) must not both read "百万像素". Prefer the locale name
  // ComfyUI stored for that node, then fall back to the node context.
  const labelOwners = new Map<string, Field[]>();
  for (const field of fields) {
    if ((!field.visible && !field.more) || field.group === 'prompt') continue;
    const owners = labelOwners.get(field.label) ?? [];
    owners.push(field);
    labelOwners.set(field.label, owners);
  }
  for (const [label, owners] of labelOwners) {
    if (owners.length < 2) continue;
    // When only one duplicate is shown by default, keep that field's name and
    // disambiguate the collapsed ones. The expanded list then reads
    // "百万像素 / 像素数量" instead of stripping the name users rely on.
    const shown = owners.filter((field) => field.visible);
    const targets = shown.length === 1 ? owners.filter((field) => !field.visible) : owners;
    if (!targets.length) continue;
    const localized = targets.map((field) => uiInputLabels.get(field.key));
    // Localized widget names only help when the duplicates are the same
    // widget on different nodes (two `megapixels` sliders). If the inputs
    // differ (`value` vs `duration_seconds`), the locale names describe the
    // input rather than the role, so node context keeps the meaning.
    const sameInput = targets.every(
      (field) => leafInput(field.input) === leafInput(targets[0]!.input),
    );
    const localizedUsable =
      sameInput &&
      localized.every((value): value is string => Boolean(value)) &&
      new Set(localized).size === targets.length &&
      // Never steal a label that belongs to a different field.
      localized.every((value) => value === label || !labelOwners.has(value));
    for (let index = 0; index < targets.length; index += 1) {
      const field = targets[index]!;
      field.label = localizedUsable
        ? localized[index]!
        : `${label}（${field.nodeTitle ?? `节点 ${field.nodeId}`}）`;
    }
    if (localizedUsable) continue;
    // Two inputs on the same node can still collide; fall back to their keys.
    const seen = new Set<string>();
    for (const field of targets) {
      if (!seen.has(field.label)) {
        seen.add(field.label);
        continue;
      }
      field.label = `${label}（${field.input}）`;
    }
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
  const slotCache = new Map<string, boolean>();
  for (const field of fields) {
    if (MEDIA_SLOT_SOURCE.test(field.nodeClass ?? '')) {
      let skippable = slotCache.get(field.nodeId);
      if (skippable === undefined) {
        skippable = mediaSlotSkippable(prompt, objectInfo, field.nodeId);
        slotCache.set(field.nodeId, skippable);
      }
      field.skippable =
        skippable && (field.kind === 'image' || MEDIA_SLOT_INPUT.test(leafInput(field.input)));
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
