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
});
