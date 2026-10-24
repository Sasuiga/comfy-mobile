import type { FieldGroup, FieldKind, FieldTier } from './types.js';

export const FIELD_KINDS: FieldKind[] = [
  'text',
  'textarea',
  'number',
  'slider',
  'select',
  'toggle',
  'image',
  'seed',
];

export const FIELD_KIND_LABELS: Record<FieldKind, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  slider: '滑块',
  select: '下拉选择',
  toggle: '开关',
  image: '图片',
  seed: '随机种子',
};

/**
 * Form groups are ordered by how often they are touched on a phone:
 * what to generate first, then how, then the model stack, then the rest.
 * Only groups that actually contain visible fields are rendered.
 */
export const DEFAULT_GROUPS: FieldGroup[] = [
  { id: 'prompt', label: '提示词', order: 10 },
  { id: 'prompt_enhance', label: '提示词增强', order: 88, collapsed: true },
  { id: 'image', label: '参考图 / 素材', order: 15 },
  { id: 'sampling', label: '生成参数', order: 20 },
  // Model loaders keep a fixed order inside 模型加载: the base stack first,
  // then each LoRA. The form renders one card per node.
  { id: 'model', label: '主模型', order: 30 },
  { id: 'clip', label: 'CLIP', order: 31 },
  { id: 'vae', label: 'VAE', order: 32 },
  { id: 'lora', label: 'LoRA', order: 35 },
  { id: 'conditioning', label: '条件控制', order: 50 },
  { id: 'upscale', label: '放大 / 后处理', order: 60 },
  { id: 'video', label: '视频', order: 65 },
  { id: 'audio', label: '音频', order: 70 },
  { id: 'output', label: '输出', order: 85 },
  { id: 'advanced', label: '高级', order: 90, collapsed: true },
];

export function isFieldKind(value: unknown): value is FieldKind {
  return typeof value === 'string' && (FIELD_KINDS as string[]).includes(value);
}

/**
 * Top-level sections of the run form, ordered by how often they matter:
 * what the workflow must consume, the output shape people confirm per run,
 * the model stack (switched for comparison), the knobs worth tuning, and
 * everything that should stay out of the way. The last two are rendered under
 * a shared 更多参数 heading.
 */
export const FIELD_TIERS: Array<{
  id: FieldTier;
  label: string;
  description: string;
  order: number;
  collapsed?: boolean;
}> = [
  {
    id: 'input',
    label: '必填内容',
    description: '提示词、参考图片或视频',
    order: 10,
  },
  {
    id: 'output',
    label: '输出规格',
    description: '分辨率、画幅、时长',
    order: 20,
  },
  {
    id: 'model',
    label: '模型加载',
    description: '主模型、CLIP、VAE 与 LoRA；每种模型独立一张卡片',
    order: 30,
  },
  {
    id: 'tuning',
    label: '可调参数',
    description: '种子、步数、采样器等；不改也能跑',
    order: 40,
    collapsed: true,
  },
  {
    id: 'advanced',
    label: '高级设置',
    description: '编码、节点细节与输出选项；一般不用动',
    order: 50,
    collapsed: true,
  },
];
