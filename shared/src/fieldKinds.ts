import type { FieldGroup, FieldKind } from './types.js';

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
  { id: 'prompt_enhance', label: '提示词增强', order: 12, collapsed: true },
  { id: 'image', label: '参考图 / 素材', order: 15 },
  { id: 'sampling', label: '生成参数', order: 20 },
  { id: 'model', label: '主模型', order: 30 },
  { id: 'lora', label: 'LoRA', order: 35 },
  { id: 'clip', label: 'CLIP', order: 40 },
  { id: 'vae', label: 'VAE', order: 45 },
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
