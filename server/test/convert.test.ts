import { describe, expect, it } from 'vitest';
import { mockApiWorkflow, mockObjectInfo, mockUiWorkflow } from '../src/mock/fixtures.js';
import { convertWorkflow, detectFormat } from '../src/workflows/convert.js';

const objectInfo = mockObjectInfo as unknown as Record<string, unknown>;

describe('workflow conversion', () => {
  it('detects UI and API formats', () => {
    expect(detectFormat(mockUiWorkflow)).toBe('ui');
    expect(detectFormat(mockApiWorkflow)).toBe('api');
    expect(detectFormat({ hello: 'world' })).toBeNull();
  });

  it('converts a saved UI workflow into an executable API prompt', () => {
    const result = convertWorkflow(mockUiWorkflow, objectInfo);
    expect(result.format).toBe('ui');
    expect(Object.keys(result.prompt)).toHaveLength(7);
    expect(result.missingNodeTypes).toEqual([]);

    expect(result.prompt['5']?.class_type).toBe('KSampler');
    expect(result.prompt['5']?.inputs.seed).toBe(123456);
    expect(result.prompt['5']?.inputs.steps).toBe(20);
    expect(result.prompt['5']?.inputs.cfg).toBe(7);
    expect(result.prompt['5']?.inputs.sampler_name).toBe('euler');
    expect(result.prompt['5']?.inputs.positive).toEqual(['2', 0]);
    expect(result.prompt['5']?.inputs.negative).toEqual(['3', 0]);
    expect(result.prompt['5']?.inputs.latent_image).toEqual(['4', 0]);
    expect(result.prompt['2']?.inputs.text).toContain('cozy cabin');
    expect(result.prompt['7']?.inputs.images).toEqual(['6', 0]);
    expect(result.prompt['7']?.inputs.filename_prefix).toBe('ComfyUI');
    // The converter must not invent control-only widgets in the API prompt.
    expect(result.prompt['5']?.inputs).not.toHaveProperty('control_after_generate');
  });

  it('accepts API workflows unchanged but returns a defensive clone', () => {
    const first = convertWorkflow(mockApiWorkflow, objectInfo);
    expect(first.format).toBe('api');
    expect(first.prompt['2']?.inputs.text).toContain('cozy cabin');

    first.prompt['2']!.inputs.text = 'mutated';
    const second = convertWorkflow(mockApiWorkflow, objectInfo);
    expect(second.prompt['2']?.inputs.text).toContain('cozy cabin');
  });

  it('unwraps prompt envelopes', () => {
    const result = convertWorkflow({ prompt: mockApiWorkflow }, objectInfo);
    expect(result.format).toBe('api');
    expect(Object.keys(result.prompt)).toHaveLength(7);
  });

  it('rejects unknown structures', () => {
    expect(() => convertWorkflow({ hello: 'world' }, objectInfo)).toThrowError(
      /无法识别工作流格式/,
    );
  });
});

/**
 * `ShowText|pysssss` has a single socket-only `text` input (no widget slots), yet
 * ComfyUI still writes the linked value into `widgets_values`. The converter
 * reports that leftover as possible widget misalignment, which the UI escalates
 * to "re-save this workflow before running".
 */
const socketInfo = {
  ...objectInfo,
  PrimitiveString: {
    input: { required: { value: ['STRING', { default: '' }] } },
    input_order: { required: ['value'] },
    output: ['STRING'],
    output_name: ['STRING'],
    name: 'PrimitiveString',
    display_name: 'String',
    category: 'utils',
  },
  'ShowText|pysssss': {
    input: { required: { text: ['STRING', { forceInput: true }] } },
    input_order: { required: ['text'] },
    output: ['STRING'],
    output_name: ['STRING'],
    name: 'ShowText|pysssss',
    display_name: 'Show Text',
    category: 'utils',
  },
  TextWithPrefix: {
    input: {
      required: {
        text: ['STRING', { forceInput: true }],
        prefix: ['STRING', { default: '' }],
      },
    },
    input_order: { required: ['text', 'prefix'] },
    output: ['STRING'],
    output_name: ['STRING'],
    name: 'TextWithPrefix',
    display_name: 'Text With Prefix',
    category: 'utils',
  },
} as unknown as Record<string, unknown>;

function textChain(consumerType: string, widgetsValues: unknown[]) {
  return {
    last_node_id: 2,
    last_link_id: 1,
    nodes: [
      {
        id: 1,
        type: 'PrimitiveString',
        pos: [80, 80],
        size: [315, 106],
        flags: {},
        order: 0,
        mode: 0,
        inputs: [],
        outputs: [{ name: 'STRING', type: 'STRING', links: [1], slot_index: 0 }],
        properties: {},
        widgets_values: ['linked text'],
      },
      {
        id: 2,
        type: consumerType,
        pos: [440, 80],
        size: [315, 106],
        flags: {},
        order: 1,
        mode: 0,
        inputs: [{ name: 'text', type: 'STRING', link: 1 }],
        outputs: [],
        properties: {},
        widgets_values: widgetsValues,
      },
    ],
    links: [[1, 1, 0, 2, 0, 'STRING']],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  };
}

describe('forceInput leftovers', () => {
  it('does not report widget misalignment on a node without widget slots', () => {
    const result = convertWorkflow(textChain('ShowText|pysssss', ['linked text']), socketInfo);
    expect(result.prompt['2']?.inputs.text).toEqual(['1', 0]);
    expect(result.warnings.join('\n')).not.toMatch(/remain unmapped|one position early/);
    expect(result.warnings).toContain(
      'Node 2 (ShowText|pysssss): 1 个多余的序列化值被忽略——该节点只有输入端口，没有可错位的参数',
    );
  });

  it('reports no warning at all when the node serialized nothing extra', () => {
    const result = convertWorkflow(textChain('ShowText|pysssss', []), socketInfo);
    expect(result.warnings).toEqual([]);
  });

  it('keeps the misalignment warning when the node really has widget slots', () => {
    const result = convertWorkflow(
      textChain('TextWithPrefix', ['PRE', 'leftover']),
      socketInfo,
    );
    expect(result.prompt['2']?.inputs.prefix).toBe('PRE');
    expect(result.warnings.some((w) => /remain unmapped/.test(w) && /one position early/.test(w))).toBe(
      true,
    );
  });
});
