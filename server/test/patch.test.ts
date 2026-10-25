import { describe, expect, it } from 'vitest';
import type { Field } from '@comfy-mobile/shared';
import { mockObjectInfo, mockUiWorkflow } from '../src/mock/fixtures.js';
import { convertWorkflow } from '../src/workflows/convert.js';
import { buildFormSchema } from '../src/workflows/schema.js';
import { applyValues, mapNodeErrors } from '../src/workflows/patch.js';

const objectInfo = mockObjectInfo as unknown as Record<string, unknown>;
const converted = convertWorkflow(mockUiWorkflow, objectInfo);
const schema = buildFormSchema({
  workflowKey: 'test-key',
  summary: {
    key: 'test-key',
    name: 'txt2img',
    path: 'workflows/txt2img-ui.json',
    source: 'remote',
  },
  workflow: mockUiWorkflow,
  prompt: converted.prompt,
  objectInfo,
  overrides: null,
  warnings: [],
  missingNodeTypes: [],
});

describe('value patching', () => {
  it('writes values into the API prompt and clamps numeric ranges', () => {
    const result = applyValues(
      converted.prompt,
      schema.fields,
      { '5.seed': 42, '5.steps': 0, '2.text': 'hello world' },
      false,
    );
    expect(result.prompt['5']?.inputs.seed).toBe(42);
    expect(result.prompt['5']?.inputs.steps).toBe(1);
    expect(result.prompt['2']?.inputs.text).toBe('hello world');
    expect(result.resolvedSeeds).toEqual({ '5.seed': 42 });
    // Deep clone: the cached conversion is untouched.
    expect(converted.prompt['5']?.inputs.seed).toBe(123456);
  });

  it('rejects unknown fields and invalid options', () => {
    expect(() =>
      applyValues(converted.prompt, schema.fields, { 'nope.key': 1 }, false),
    ).toThrowError(/未知参数/);

    expect(() =>
      applyValues(converted.prompt, schema.fields, { '1.ckpt_name': 'missing.safetensors' }, false),
    ).toThrowError(/选项已失效/);
  });

  it('randomizes every seed field when requested', () => {
    const result = applyValues(
      converted.prompt,
      schema.fields,
      { '5.seed': 1 },
      true,
    );
    const seed = result.prompt['5']?.inputs.seed;
    expect(typeof seed).toBe('number');
    expect(seed).not.toBe(1);
    expect((seed as number) >= 0 && (seed as number) < 2 ** 32).toBe(true);
    expect(result.resolvedSeeds['5.seed']).toBe(seed);
  });

  it('accepts asset hashes for image fields', () => {
    const imageField: Field = {
      key: '8.image',
      nodeId: '8',
      input: 'image',
      widgetName: 'image',
      kind: 'image',
      label: '输入图片',
      group: 'image',
      order: 0,
      required: true,
      constraints: {},
      visible: true,
      advanced: false,
      source: 'heuristic',
    };
    const prompt = {
      '8': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
    };
    const result = applyValues(prompt, [imageField], { '8.image': 'blake3:abc' }, false);
    expect(result.prompt['8']?.inputs.image).toBe('blake3:abc');
  });

  it('drops a cancelled reference-image slot and its downstream link', () => {
    const slotField: Field = {
      key: '8.image',
      nodeId: '8',
      input: 'image',
      widgetName: 'image',
      kind: 'image',
      label: '参考图 #1',
      group: 'image',
      order: 0,
      required: true,
      constraints: {},
      visible: true,
      advanced: false,
      source: 'heuristic',
      skippable: true,
    };
    const prompt = {
      '8': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '9': {
        class_type: 'RefDirector',
        inputs: { prompt: 'hello', ref_image: ['8', 0] as [string, number] },
      },
    };
    const result = applyValues(prompt, [slotField], { '8.image': null }, false);
    expect(result.prompt['8']).toBeUndefined();
    expect(result.prompt['9']?.inputs).toEqual({ prompt: 'hello' });

    // Older presets used an empty string for a cancelled slot.
    const empty = applyValues(prompt, [slotField], { '8.image': '' }, false);
    expect(empty.prompt['8']).toBeUndefined();
  });

  it('refuses to cancel a slot that feeds a required input', () => {
    const slotField: Field = {
      key: '8.image',
      nodeId: '8',
      input: 'image',
      widgetName: 'image',
      kind: 'image',
      label: '参考图 #1',
      group: 'image',
      order: 0,
      required: true,
      constraints: {},
      visible: true,
      advanced: false,
      source: 'heuristic',
      skippable: false,
    };
    const prompt = {
      '8': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '9': {
        class_type: 'RefDirector',
        inputs: { prompt: 'hello', ref_image: ['8', 0] as [string, number] },
      },
    };
    expect(() => applyValues(prompt, [slotField], { '8.image': null }, false)).toThrowError(
      /不能为空/,
    );
  });

  it('bypasses a node and passes its matching input through', () => {
    const nodeField: Field = {
      key: '2.scale',
      nodeId: '2',
      input: 'scale',
      widgetName: 'scale',
      kind: 'number',
      label: '强度',
      group: 'advanced',
      order: 0,
      required: false,
      constraints: {},
      visible: true,
      advanced: false,
      source: 'heuristic',
      nodeBypassable: true,
    };
    const prompt = {
      '1': { class_type: 'BaseModel', inputs: {} },
      '2': { class_type: 'PassNode', inputs: { model: ['1', 0], scale: 1 } },
      '3': { class_type: 'UseModel', inputs: { model: ['2', 0] } },
    };
    const objectInfo = {
      BaseModel: { output: ['MODEL'] },
      PassNode: {
        input: { required: { model: ['MODEL'], scale: ['FLOAT'] } },
        input_order: { required: ['model', 'scale'] },
        output: ['MODEL'],
      },
      UseModel: { input: { required: { model: ['MODEL'] } } },
    };

    const result = applyValues(prompt, [nodeField], {}, false, {
      bypass: ['2'],
      objectInfo,
    });
    expect(result.prompt['2']).toBeUndefined();
    expect(result.prompt['3']?.inputs.model).toEqual(['1', 0]);
  });

  it('ignores bypass ids the schema does not allow', () => {
    const nodeField: Field = {
      key: '2.scale',
      nodeId: '2',
      input: 'scale',
      widgetName: 'scale',
      kind: 'number',
      label: '强度',
      group: 'advanced',
      order: 0,
      required: false,
      constraints: {},
      visible: true,
      advanced: false,
      source: 'heuristic',
      nodeBypassable: false,
    };
    const prompt = {
      '2': { class_type: 'PassNode', inputs: { scale: 1 } },
    };
    const result = applyValues(prompt, [nodeField], {}, false, { bypass: ['2'] });
    expect(result.prompt['2']).toBeDefined();
  });

  it('maps ComfyUI node errors back to field keys', () => {
    const errors = mapNodeErrors(
      {
        node_errors: {
          '2': {
            class_type: 'CLIPTextEncode',
            errors: [{ message: 'bad text', input_name: 'text' }],
          },
        },
      },
      schema.fields,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      nodeId: '2',
      fieldKey: '2.text',
      message: 'bad text',
    });
  });

  it('accepts an untouched value that exceeds the UI length cap but rejects edits', () => {
    // A schema built before a cap was raised (or a preset from another client)
    // can still carry maxLength below the workflow's own saved prompt.
    const saved = 'x'.repeat(12_000);
    const longField: Field = {
      key: '1.positive',
      nodeId: '1',
      input: 'positive',
      widgetName: 'positive',
      kind: 'textarea',
      label: '正向提示词',
      group: 'prompt',
      order: 0,
      required: true,
      default: saved,
      constraints: { multiline: true, maxLength: 10_000 },
      visible: true,
      advanced: false,
      source: 'heuristic',
    };
    const prompt = { '1': { class_type: 'EasyPositive', inputs: { positive: saved } } };

    const result = applyValues(prompt, [longField], { '1.positive': saved }, false);
    expect(result.prompt['1']?.inputs.positive).toBe(saved);

    // Real edits are still bounded, so a client cannot smuggle in unbounded text.
    expect(() =>
      applyValues(prompt, [longField], { '1.positive': `${saved}y` }, false),
    ).toThrowError(/超出长度限制/);
  });

  it('submits numeric combo options with their declared type', () => {
    const selectField: Field = {
      key: '9.bit_depth',
      nodeId: '9',
      input: 'bit_depth',
      widgetName: 'bit_depth',
      kind: 'select',
      label: '位深',
      group: 'video',
      order: 0,
      required: false,
      constraints: {
        options: [
          { value: 'auto', label: 'auto' },
          { value: '8', label: '8', rawValue: 8 },
        ],
      },
      visible: true,
      advanced: false,
      source: 'heuristic',
    };
    const prompt = {
      '9': { class_type: 'CreateVideo', inputs: { bit_depth: 8 } },
    };
    const result = applyValues(prompt, [selectField], { '9.bit_depth': '8' }, false);
    expect(result.prompt['9']?.inputs.bit_depth).toBe(8);
  });

  it('lets an optional combo be cleared', () => {
    const selectField: Field = {
      key: '9.mode',
      nodeId: '9',
      input: 'mode',
      widgetName: 'mode',
      kind: 'select',
      label: '模式',
      group: 'advanced',
      order: 0,
      required: false,
      constraints: { options: [{ value: 'a', label: 'a' }] },
      visible: true,
      advanced: false,
      source: 'heuristic',
    };
    const result = applyValues(
      { '9': { class_type: 'SomeNode', inputs: { mode: 'a' } } },
      [selectField],
      { '9.mode': '' },
      false,
    );
    expect(result.prompt['9']?.inputs.mode).toBe('');
  });

  it('keeps a missing linked input node-level instead of blaming a widget', () => {
    const megapixels: Field = {
      key: '36.megapixels',
      nodeId: '36',
      nodeClass: 'ImageScaleToTotalPixels',
      input: 'megapixels',
      widgetName: 'megapixels',
      kind: 'slider',
      label: '像素数量',
      group: 'upscale',
      tier: 'tuning',
      order: 0,
      required: true,
      constraints: { min: 0.01, max: 16, step: 0.01 },
      visible: true,
      advanced: false,
      source: 'heuristic',
    };
    const errors = mapNodeErrors(
      {
        node_errors: {
          '36': {
            class_type: 'ImageScaleToTotalPixels',
            errors: [
              {
                type: 'required_input_missing',
                message: 'Required input is missing',
                extra_info: { input_name: 'image' },
              },
            ],
          },
        },
      },
      [megapixels],
    );
    // `image` is a linked input with no widget; it must not land on the
    // megapixels slider just because that is the node's first visible field.
    expect(errors[0]?.fieldKey).toBeUndefined();
    expect(errors[0]?.message).toContain('image');
    expect(errors[0]?.message).toContain('ImageScaleToTotalPixels');
  });

  it('falls back to the first visible field when ComfyUI omits the input name', () => {
    const field36: Field = {
      key: '36.megapixels',
      nodeId: '36',
      nodeClass: 'SomeNode',
      input: 'megapixels',
      widgetName: 'megapixels',
      kind: 'slider',
      label: '百万像素',
      group: 'sampling',
      order: 0,
      required: true,
      constraints: {},
      visible: true,
      advanced: false,
      source: 'heuristic',
    };
    const errors = mapNodeErrors(
      { node_errors: { '36': { errors: [{ message: 'bad value' }] } } },
      [field36],
    );
    expect(errors[0]?.fieldKey).toBe('36.megapixels');
  });

  it('reads the offending input from extra_info when mapping node errors', () => {
    const errors = mapNodeErrors(
      {
        node_errors: {
          '5': {
            class_type: 'KSampler',
            errors: [
              {
                type: 'value_not_in_list',
                message: 'Value not in list',
                extra_info: { input_name: 'sampler_name', received_value: 'nope' },
              },
            ],
          },
        },
      },
      schema.fields,
    );
    expect(errors[0]?.fieldKey).toBe('5.sampler_name');
  });
});
