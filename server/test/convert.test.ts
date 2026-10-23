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
