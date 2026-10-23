import { describe, expect, it } from 'vitest';
import type { FormOverrides, WorkflowSummary } from '@comfy-mobile/shared';
import { mockObjectInfo, mockUiWorkflow } from '../src/mock/fixtures.js';
import { convertWorkflow } from '../src/workflows/convert.js';
import { buildFormSchema } from '../src/workflows/schema.js';

const objectInfo = mockObjectInfo as unknown as Record<string, unknown>;
const summary: WorkflowSummary = {
  key: 'test-key',
  name: 'txt2img-ui',
  path: 'workflows/txt2img-ui.json',
  source: 'remote',
  format: 'ui',
  hasAppConfig: true,
};

function build(workflow: unknown, overrides: FormOverrides | null = null) {
  const converted = convertWorkflow(workflow, objectInfo);
  return buildFormSchema({
    workflowKey: 'test-key',
    summary,
    workflow,
    prompt: converted.prompt,
    objectInfo,
    overrides,
    warnings: converted.warnings,
    missingNodeTypes: converted.missingNodeTypes,
  });
}

function field(fields: ReturnType<typeof build>['fields'], key: string) {
  const found = fields.find((item) => item.key === key);
  if (!found) throw new Error(`missing field ${key}`);
  return found;
}

describe('form schema', () => {
  it('uses App Builder linearData as the visible field set', () => {
    const schema = build(mockUiWorkflow);
    const visible = schema.fields.filter((item) => item.visible);
    expect(visible.map((item) => item.key).sort()).toEqual(
      ['1.ckpt_name', '2.text', '3.text', '4.height', '4.width', '5.cfg', '5.seed', '5.steps'].sort(),
    );

    const positive = field(schema.fields, '2.text');
    expect(positive.kind).toBe('textarea');
    expect(positive.label).toBe('正向提示词');
    expect(positive.description).toBe('描述你想生成的画面');
    expect(positive.source).toBe('linear');
    expect(positive.group).toBe('prompt');

    const negative = field(schema.fields, '3.text');
    expect(negative.label).toBe('反向提示词');

    const seed = field(schema.fields, '5.seed');
    expect(seed.kind).toBe('seed');
    expect(seed.constraints).toMatchObject({ min: 0, max: 4_294_967_295, integer: true });

    expect(field(schema.fields, '5.steps').kind).toBe('number');
    expect(field(schema.fields, '5.cfg').kind).toBe('slider');
    expect(field(schema.fields, '4.width').kind).toBe('number');
    expect(field(schema.fields, '1.ckpt_name').kind).toBe('select');
    expect(field(schema.fields, '1.ckpt_name').constraints.options?.length).toBe(2);

    const hidden = field(schema.fields, '5.sampler_name');
    expect(hidden.visible).toBe(false);
    expect(hidden.source).toBe('heuristic');
  });

  it('lets web overrides win over App Builder fields', () => {
    const schema = build(mockUiWorkflow, {
      version: 1,
      updatedAt: new Date().toISOString(),
      fields: [
        { key: '5.steps', label: '采样步数', kind: 'slider', visible: true, order: 0 },
        { key: '5.sampler_name', visible: true, label: '采样方法' },
        { key: '9.removed', label: '已删除' },
      ],
    });

    const steps = field(schema.fields, '5.steps');
    expect(steps.label).toBe('采样步数');
    expect(steps.kind).toBe('slider');
    expect(steps.overridden).toBe(true);

    const sampler = field(schema.fields, '5.sampler_name');
    expect(sampler.visible).toBe(true);
    expect(sampler.label).toBe('采样方法');

    expect(schema.staleOverrides).toContain('9.removed');
  });

  it('supports [UI] title markers without App Builder data', () => {
    const workflow = structuredClone(mockUiWorkflow) as Record<string, unknown> & {
      nodes: Array<Record<string, unknown>>;
      extra: Record<string, unknown>;
    };
    delete workflow.extra.linearData;
    const nodes = workflow.nodes;
    nodes[1]!.title = '[UI:画面描述]';
    nodes[2]!.title = '[UI hide]';

    const schema = build(workflow);
    const promptField = field(schema.fields, '2.text');
    expect(promptField.source).toBe('marker');
    expect(promptField.label).toBe('画面描述');
    expect(promptField.visible).toBe(true);

    // Hidden markers remove the node entirely.
    expect(schema.fields.some((item) => item.nodeId === '3')).toBe(false);
  });
});
