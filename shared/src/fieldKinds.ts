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

export const DEFAULT_GROUPS: FieldGroup[] = [
  { id: 'prompt', label: '提示词', order: 10 },
  { id: 'image', label: '图片', order: 20 },
  { id: 'model', label: '模型', order: 30 },
  { id: 'sampling', label: '采样参数', order: 40 },
  { id: 'output', label: '输出', order: 50 },
  { id: 'advanced', label: '高级', order: 90, collapsed: true },
];

export function isFieldKind(value: unknown): value is FieldKind {
  return typeof value === 'string' && (FIELD_KINDS as string[]).includes(value);
}
