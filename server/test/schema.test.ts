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

  it('keeps the minimal default set and lets overrides re-expose a parameter', () => {
    const workflow = structuredClone(mockUiWorkflow) as Record<string, unknown> & {
      extra: Record<string, unknown>;
    };
    // No App Builder list: the app invokes a workflow configured in ComfyUI.
    delete workflow.extra.linearData;
    const schema = build(workflow);

    // Must-fill inputs and the per-run output shape stay visible.
    expect(field(schema.fields, '2.text').visible).toBe(true);
    expect(field(schema.fields, '4.width').visible).toBe(true);
    expect(field(schema.fields, '4.height').visible).toBe(true);

    // Model loading stays reachable so a checkpoint or LoRA can be swapped
    // without opening 更多参数; sampling knobs keep the saved value.
    const steps = field(schema.fields, '5.steps');
    expect(steps.visible).toBe(false);
    expect(steps.more).toBe(true);
    expect(steps.default).toBe(20);
    const checkpoint = field(schema.fields, '1.ckpt_name');
    expect(checkpoint.visible).toBe(true);
    expect(checkpoint.tier).toBe('model');

    // An explicit override is an author decision, not a default.
    const overridden = build(workflow, {
      version: 1,
      updatedAt: new Date().toISOString(),
      fields: [{ key: '5.steps', visible: true }],
    });
    expect(field(overridden.fields, '5.steps').visible).toBe(true);
    expect(field(overridden.fields, '5.steps').more).toBeUndefined();
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

  it('only marks media loader slots skippable when no consumer requires the link', () => {
    const loadImage = (mockObjectInfo as Record<string, unknown>).LoadImage;
    const prompt = {
      '1': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '2': { class_type: 'RefDirector', inputs: { prompt: 'hello', ref_image: ['1', 0] } },
    };
    const base = {
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    };

    const optional = buildFormSchema({
      ...base,
      objectInfo: {
        LoadImage: loadImage,
        RefDirector: {
          input: {
            required: { prompt: ['STRING', { multiline: true }] },
            optional: { ref_image: ['IMAGE'] },
          },
          input_order: { required: ['prompt'], optional: ['ref_image'] },
        },
      } as unknown as Record<string, unknown>,
    });
    expect(field(optional.fields, '1.image').skippable).toBe(true);

    // Dropping a link that a consumer declares required makes ComfyUI reject
    // the whole prompt ("Required input is missing"), so that slot must stay
    // mandatory. Media loaders still never offer a node-level bypass.
    const required = buildFormSchema({
      ...base,
      objectInfo: {
        LoadImage: loadImage,
        RefDirector: {
          input: {
            required: { prompt: ['STRING', { multiline: true }], ref_image: ['IMAGE'] },
          },
          input_order: { required: ['prompt', 'ref_image'] },
        },
      } as unknown as Record<string, unknown>,
    });
    expect(field(required.fields, '1.image').skippable).toBe(false);
    expect(field(required.fields, '1.image').nodeBypassable).toBeUndefined();
  });

  it('disambiguates same-named widgets on different nodes and demotes scalers', () => {
    const loadImage = (mockObjectInfo as Record<string, unknown>).LoadImage;
    const prompt = {
      '1': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '2': {
        class_type: 'ImageScaleToTotalPixels',
        inputs: {
          image: ['1', 0] as [string, number],
          upscale_method: 'lanczos',
          megapixels: 3.1,
          resolution_steps: 32,
        },
      },
      '3': {
        class_type: 'ResolutionSelector',
        inputs: { aspect_ratio: '16:9 (Widescreen)', megapixels: 2, multiple: 32 },
      },
    };
    const objectInfo = {
      LoadImage: loadImage,
      ImageScaleToTotalPixels: {
        input: {
          required: {
            image: ['IMAGE'],
            upscale_method: [['lanczos', 'nearest-exact'], {}],
            megapixels: ['FLOAT', { default: 1, min: 0.01, max: 16, step: 0.01 }],
            resolution_steps: ['INT', { default: 1, min: 1, max: 256 }],
          },
        },
        output: ['IMAGE'],
      },
      ResolutionSelector: {
        input: {
          required: {
            aspect_ratio: [['1:1 (Square)', '16:9 (Widescreen)'], {}],
            megapixels: ['FLOAT', { default: 1, min: 0.1, max: 16, step: 0.1 }],
            multiple: ['INT', { default: 8, min: 8, max: 128, step: 4 }],
          },
        },
        output: ['INT', 'INT'],
      },
    } as unknown as Record<string, unknown>;
    const base = {
      workflowKey: 'test-key',
      summary,
      prompt,
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    };

    // ComfyUI's own locale names tell the two apart: 百万像素 (generation)
    // vs 像素数量 (reference-image scaling).
    const localized = buildFormSchema({
      ...base,
      workflow: {
        nodes: [
          { id: 1, type: 'LoadImage', pos: [0, 0] },
          {
            id: 2,
            type: 'ImageScaleToTotalPixels',
            pos: [0, 100],
            inputs: [{ name: 'megapixels', localized_name: '像素数量' }],
          },
          {
            id: 3,
            type: 'ResolutionSelector',
            pos: [0, 200],
            inputs: [{ name: 'megapixels', localized_name: '百万像素' }],
          },
        ],
      },
    });
    expect(field(localized.fields, '2.megapixels').label).toBe('像素数量');
    expect(field(localized.fields, '3.megapixels').label).toBe('百万像素');

    // The scaler resizes a reference image, so it is a tuning knob hidden
    // behind 更多参数; the picker that defines the generated frame stays in
    // 输出规格 and is shown by default.
    expect(field(localized.fields, '2.megapixels').tier).toBe('tuning');
    expect(field(localized.fields, '2.megapixels').more).toBe(true);
    expect(field(localized.fields, '2.megapixels').visible).toBe(false);
    expect(field(localized.fields, '3.megapixels').tier).toBe('output');
    expect(field(localized.fields, '3.megapixels').visible).toBe(true);

    // Without locale names, the collapsed duplicate takes its node id while
    // the primary field keeps the plain label.
    const plain = buildFormSchema({ ...base, workflow: { nodes: [] } });
    expect(field(plain.fields, '2.megapixels').label).toBe('百万像素（节点 2）');
    expect(field(plain.fields, '3.megapixels').label).toBe('百万像素');
  });

  it('keeps numeric combo types and promotes video shape/timing fields', () => {
    const prompt = {
      '1': {
        class_type: 'CreateVideo',
        inputs: {
          fps: 24,
          bit_depth: 8,
          color_space: 'sRGB',
          codec: 'none',
        },
      },
      '2': { class_type: 'PrimitiveFloat', inputs: { value: 5 }, _meta: { title: 'Float (duration)' } },
      '3': { class_type: 'RandomNoise', inputs: { noise_seed: 7 } },
      '4': {
        class_type: 'MinimaxHailuo03TextToVideoNode',
        inputs: {
          model: 'MiniMax H3',
          'model.prompt': 'a cat',
          'model.resolution': '768P',
          'model.ratio': '16:9',
          'model.duration': 5,
          seed: 42,
        },
      },
    };
    const objectInfo = {
      CreateVideo: {
        input: {
          required: {
            fps: ['FLOAT', { default: 30, min: 1, max: 120, step: 1 }],
            bit_depth: ['COMBO', { options: ['auto', 8, 10], default: 'auto' }],
            color_space: ['COMBO', { options: ['sRGB', 'HDR'] }],
            codec: ['COMBO', { options: ['none', 'auto'] }],
          },
        },
        output: ['VIDEO'],
      },
      PrimitiveFloat: {
        input: { required: { value: ['FLOAT', { default: 1 }] } },
        output: ['FLOAT'],
      },
      RandomNoise: {
        input: { required: { noise_seed: ['INT', { default: 0, min: 0, max: 4294967295 }] } },
        output: ['NOISE'],
      },
      MinimaxHailuo03TextToVideoNode: {
        input: {
          required: {
            model: [['MiniMax H3'], {}],
            'model.prompt': ['STRING', { multiline: true }],
            'model.resolution': [['768P', '2K'], {}],
            'model.ratio': [['16:9', '9:16'], {}],
            'model.duration': ['INT', { default: 5, min: 4, max: 15, step: 1 }],
            seed: ['INT', { default: 42, min: 0, max: 4294967295 }],
          },
        },
      },
    } as unknown as Record<string, unknown>;

    const schema = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });

    // Numeric combo options keep their declared type so the run does not send
    // "8" where ComfyUI expects 8.
    const bitDepth = field(schema.fields, '1.bit_depth');
    expect(bitDepth.kind).toBe('select');
    expect(bitDepth.constraints.options).toContainEqual({
      value: '8',
      label: '8',
      rawValue: 8,
    });
    expect(bitDepth.tier).toBe('advanced');

    // Timing is confirmed per run; seeds are optional tuning.
    expect(field(schema.fields, '1.fps').tier).toBe('output');
    expect(field(schema.fields, '1.fps').visible).toBe(true);
    expect(field(schema.fields, '3.noise_seed').tier).toBe('tuning');
    // Without App Builder data the form only shows inputs and output shape;
    // model/codec/sampler knobs stay collapsed but retain their saved values.
    expect(field(schema.fields, '3.noise_seed').visible).toBe(false);
    expect(field(schema.fields, '3.noise_seed').more).toBe(true);
    expect(bitDepth.visible).toBe(false);
    expect(bitDepth.more).toBe(true);
    expect(field(schema.fields, '4.model.prompt').visible).toBe(true);

    // Primitive durations and V3 dynamic-combo leaves are the 时长 control.
    const primitiveDuration = field(schema.fields, '2.value');
    expect(primitiveDuration.label.startsWith('时长')).toBe(true);
    expect(primitiveDuration.group).toBe('sampling');

    const duration = field(schema.fields, '4.model.duration');
    expect(duration.label.startsWith('时长')).toBe(true);
    expect(duration.group).toBe('sampling');
    expect(duration.kind).toBe('slider');

    // Dotted leaves are classified by their leaf name, not the full key.
    expect(field(schema.fields, '4.model.prompt').group).toBe('prompt');
    expect(field(schema.fields, '4.model.resolution').group).toBe('sampling');

    const order = schema.fields.map((item) => item.key);
    expect(order.indexOf('4.model.resolution')).toBeLessThan(order.indexOf('2.value'));
    expect(order.indexOf('2.value')).toBeLessThan(order.indexOf('3.noise_seed'));
  });

  it('resolves specs of V3 dynamic-combo leaves from the selected option', () => {
    const prompt = {
      '1': {
        class_type: 'MiniMaxNode',
        inputs: {
          model: 'MiniMax H3',
          'model.prompt': 'a cat',
          'model.resolution': '768P',
          'model.duration': 5,
          seed: 42,
        },
      },
    };
    const objectInfo = {
      MiniMaxNode: {
        input: {
          required: {
            model: [
              'COMFY_DYNAMICCOMBO_V3',
              {
                options: [
                  {
                    key: 'MiniMax H3',
                    name: 'MiniMax H3 官方',
                    inputs: {
                      required: {
                        prompt: ['STRING', { multiline: true }],
                        resolution: [['768P', '2K'], {}],
                        duration: ['INT', { default: 5, min: 4, max: 15, step: 1 }],
                      },
                    },
                  },
                  {
                    key: 'Other',
                    inputs: { required: { prompt: ['STRING'] } },
                  },
                ],
              },
            ],
            seed: ['INT', { default: 0, min: 0, max: 4_294_967_295 }],
          },
        },
      },
    } as unknown as Record<string, unknown>;

    const schema = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });

    // Nested leaves take their spec from the selected dynamic-combo option.
    // Without it the prompt would be single-line and resolution free text —
    // the latter is exactly the "Value not in list" class of failure.
    const text = field(schema.fields, '1.model.prompt');
    expect(text.kind).toBe('textarea');
    expect(text.required).toBe(true);
    expect(text.tier).toBe('input');

    const resolution = field(schema.fields, '1.model.resolution');
    expect(resolution.kind).toBe('select');
    expect(resolution.constraints.options?.map((option) => option.value)).toEqual([
      '768P',
      '2K',
    ]);
    expect(resolution.required).toBe(true);
    expect(resolution.tier).toBe('output');

    const duration = field(schema.fields, '1.model.duration');
    expect(duration.kind).toBe('slider');
    expect(duration.constraints).toMatchObject({ min: 4, max: 15, step: 1 });
    expect(duration.tier).toBe('output');

    // Dynamic-combo option keys are the submitted values, not their labels.
    const model = field(schema.fields, '1.model');
    expect(model.kind).toBe('select');
    expect(model.constraints.options?.[0]).toMatchObject({
      value: 'MiniMax H3',
      label: 'MiniMax H3 官方',
    });
    expect(model.tier).toBe('advanced');

    expect(field(schema.fields, '1.seed').tier).toBe('tuning');
  });

  it('repairs stale enum defaults but preserves missing assets', () => {
    const prompt = {
      '1': {
        class_type: 'KSampler',
        inputs: { sampler_name: 'gone', scheduler: 'normal', denoise: 1 },
      },
      '2': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'gone.safetensors' },
      },
    };
    const objectInfo = {
      KSampler: {
        input: {
          required: {
            sampler_name: [['euler', 'dpmpp_2m'], {}],
            scheduler: [['normal', 'karras'], {}],
            denoise: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
          },
        },
      },
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['other.safetensors'], {}] } },
      },
    } as unknown as Record<string, unknown>;

    const schema = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });

    // API-format prompts skip the converter, so the schema is the last place
    // that can turn a stale enum into a runnable value.
    expect(field(schema.fields, '1.sampler_name').default).toBe('euler');
    // A missing model file must not be silently swapped.
    expect(field(schema.fields, '2.ckpt_name').default).toBe('gone.safetensors');

    const warnings = schema.warnings.join('\n');
    expect(warnings).toContain('substituting the first available option "euler"');
    expect(warnings).toContain('not installed on the connected server');
  });

  it('never caps a text field below the value the workflow was saved with', () => {
    // Qwen-style pipelines embed long fixed prompts; the form resends them on
    // every run, so a UI cap below the saved length would block the workflow.
    const long = `固定提示词${'x'.repeat(17_000)}`;
    const prompt = {
      '1': { class_type: 'EasyPositive', inputs: { positive: long } },
      '2': { class_type: 'EasyPositive', inputs: { positive: 'short prompt' } },
    };
    const objectInfo = {
      EasyPositive: {
        input: { required: { positive: ['STRING', { multiline: true }] } },
        input_order: { required: ['positive'] },
        output: ['CONDITIONING'],
      },
    } as unknown as Record<string, unknown>;

    const schema = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });

    const savedLong = field(schema.fields, '1.positive');
    expect(savedLong.kind).toBe('textarea');
    expect(savedLong.default).toBe(long);
    expect(savedLong.constraints.maxLength).toBe(long.length);

    // Ordinary fields keep the default UI cap.
    expect(field(schema.fields, '2.positive').constraints.maxLength).toBe(10_000);
  });

  it('marks a node bypassable only when required consumers can pass through', () => {
    const prompt = {
      '1': { class_type: 'BaseModel', inputs: {} },
      '2': { class_type: 'PassNode', inputs: { model: ['1', 0], scale: 1 } },
      '3': { class_type: 'UseModel', inputs: { model: ['2', 0] } },
    };
    const objectInfo = {
      BaseModel: { output: ['MODEL'] },
      PassNode: {
        input: {
          required: { model: ['MODEL'], scale: ['FLOAT', { default: 1 }] },
        },
        input_order: { required: ['model', 'scale'] },
        output: ['MODEL'],
      },
      UseModel: {
        input: { required: { model: ['MODEL'] } },
        input_order: { required: ['model'] },
      },
    } as unknown as Record<string, unknown>;

    const connected = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });
    // The model input is linked, so UseModel's required link can be rerouted.
    expect(field(connected.fields, '2.scale').nodeBypassable).toBe(true);

    const disconnected = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt: {
        ...prompt,
        '2': { class_type: 'PassNode', inputs: { scale: 1 } },
      },
      objectInfo,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });
    // Nothing to pass through: bypassing would break UseModel.
    expect(field(disconnected.fields, '2.scale').nodeBypassable).toBe(false);
  });

  it('puts every model loader in its own model-tier node and keeps LoRA bypassable', () => {
    const prompt = {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
      },
      '2': {
        class_type: 'LoraLoader',
        inputs: {
          model: ['1', 0],
          clip: ['1', 1],
          lora_name: 'detail.safetensors',
          strength_model: 1,
          strength_clip: 1,
        },
      },
      '3': {
        class_type: 'KSampler',
        inputs: {
          model: ['2', 0],
          seed: 1,
          steps: 20,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
        },
      },
      '4': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      '5': {
        class_type: 'CLIPLoader',
        inputs: { clip_name: 'clip_l.safetensors', type: 'stable_diffusion' },
      },
    };
    const loaders = {
      ...mockObjectInfo,
      VAELoader: {
        input: { required: { vae_name: [['ae.safetensors'], {}] } },
        input_order: { required: ['vae_name'] },
        output: ['VAE'],
        output_name: ['VAE'],
        name: 'VAELoader',
      },
      CLIPLoader: {
        input: {
          required: {
            clip_name: [['clip_l.safetensors', 't5.safetensors'], {}],
            type: [['stable_diffusion', 'flux'], {}],
          },
        },
        input_order: { required: ['clip_name', 'type'] },
        output: ['CLIP'],
        output_name: ['CLIP'],
        name: 'CLIPLoader',
      },
    } as unknown as Record<string, unknown>;

    const schema = buildFormSchema({
      workflowKey: 'test-key',
      summary,
      workflow: { nodes: [] },
      prompt,
      objectInfo: loaders,
      overrides: null,
      warnings: [],
      missingNodeTypes: [],
    });

    // 模型加载 is a step of its own: every loader field leaves 高级设置.
    for (const key of ['1.ckpt_name', '2.lora_name', '4.vae_name', '5.clip_name']) {
      expect(field(schema.fields, key).tier).toBe('model');
      expect(field(schema.fields, key).visible).toBe(true);
    }
    // Node identity drives the per-model cards, so a LoRA never shares a card
    // with the checkpoint or with another LoRA.
    expect(field(schema.fields, '2.lora_name').nodeId).not.toBe(
      field(schema.fields, '1.ckpt_name').nodeId,
    );
    // Switching the main model or toggling a LoRA must not require editing the
    // workflow: a LoRA can be bypassed while its MODEL/CLIP links pass through.
    expect(field(schema.fields, '2.lora_name').nodeBypassable).toBe(true);
  });
});
