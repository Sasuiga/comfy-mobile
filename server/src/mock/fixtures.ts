const CHECKPOINTS = ['sd_xl_base_1.0.safetensors', 'dreamshaper_8.safetensors'];
const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_sde'];
const SCHEDULERS = ['normal', 'karras', 'exponential', 'sgm_uniform'];

export const mockObjectInfo = {
  CheckpointLoaderSimple: {
    input: {
      required: {
        ckpt_name: [CHECKPOINTS, { default: CHECKPOINTS[0] }],
      },
    },
    input_order: { required: ['ckpt_name'] },
    output: ['MODEL', 'CLIP', 'VAE'],
    output_name: ['MODEL', 'CLIP', 'VAE'],
    name: 'CheckpointLoaderSimple',
    display_name: 'Load Checkpoint',
    category: 'loaders',
  },
  CLIPTextEncode: {
    input: {
      required: {
        text: ['STRING', { multiline: true, default: '' }],
        clip: ['CLIP'],
      },
    },
    input_order: { required: ['text', 'clip'] },
    output: ['CONDITIONING'],
    output_name: ['CONDITIONING'],
    name: 'CLIPTextEncode',
    display_name: 'CLIP Text Encode (Prompt)',
    category: 'conditioning',
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ['INT', { default: 1024, min: 16, max: 16384, step: 8 }],
        height: ['INT', { default: 1024, min: 16, max: 16384, step: 8 }],
        batch_size: ['INT', { default: 1, min: 1, max: 64 }],
      },
    },
    input_order: { required: ['width', 'height', 'batch_size'] },
    output: ['LATENT'],
    output_name: ['LATENT'],
    name: 'EmptyLatentImage',
    display_name: 'Empty Latent Image',
    category: 'latent',
  },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: 4294967295, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 7, min: 0, max: 100, step: 0.1 }],
        sampler_name: [SAMPLERS, { default: SAMPLERS[0] }],
        scheduler: [SCHEDULERS, { default: SCHEDULERS[0] }],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
      },
    },
    input_order: {
      required: [
        'model',
        'seed',
        'steps',
        'cfg',
        'sampler_name',
        'scheduler',
        'positive',
        'negative',
        'latent_image',
        'denoise',
      ],
    },
    output: ['LATENT'],
    output_name: ['LATENT'],
    name: 'KSampler',
    display_name: 'KSampler',
    category: 'sampling',
  },
  KSamplerAdvanced: {
    input: {
      required: {
        model: ['MODEL'],
        add_noise: ['BOOLEAN', { default: true }],
        noise_seed: ['INT', { default: 0, min: 0, max: 4294967295, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 7, min: 0, max: 100, step: 0.1 }],
        sampler_name: [SAMPLERS, { default: SAMPLERS[0] }],
        scheduler: [SCHEDULERS, { default: SCHEDULERS[0] }],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        start_at_step: ['INT', { default: 0, min: 0, max: 10000 }],
        end_at_step: ['INT', { default: 10000, min: 0, max: 10000 }],
        return_with_leftover_noise: ['BOOLEAN', { default: false }],
      },
    },
    output: ['LATENT'],
    output_name: ['LATENT'],
    name: 'KSamplerAdvanced',
    display_name: 'KSampler (Advanced)',
    category: 'sampling',
  },
  LoadImage: {
    input: {
      required: {
        image: [['example.png', 'uploaded.png'], { image_upload: true }],
      },
    },
    input_order: { required: ['image'] },
    output: ['IMAGE', 'MASK'],
    output_name: ['IMAGE', 'MASK'],
    name: 'LoadImage',
    display_name: 'Load Image',
    category: 'image',
  },
  VAEDecode: {
    input: {
      required: {
        samples: ['LATENT'],
        vae: ['VAE'],
      },
    },
    input_order: { required: ['samples', 'vae'] },
    output: ['IMAGE'],
    output_name: ['IMAGE'],
    name: 'VAEDecode',
    display_name: 'VAE Decode',
    category: 'latent',
  },
  VAEEncode: {
    input: {
      required: {
        pixels: ['IMAGE'],
        vae: ['VAE'],
      },
    },
    input_order: { required: ['pixels', 'vae'] },
    output: ['LATENT'],
    output_name: ['LATENT'],
    name: 'VAEEncode',
    display_name: 'VAE Encode',
    category: 'latent',
  },
  SaveImage: {
    input: {
      required: {
        images: ['IMAGE'],
        filename_prefix: ['STRING', { default: 'ComfyUI' }],
      },
    },
    input_order: { required: ['images', 'filename_prefix'] },
    output: [],
    output_name: [],
    name: 'SaveImage',
    display_name: 'Save Image',
    category: 'image',
  },
  PreviewImage: {
    input: { required: { images: ['IMAGE'] } },
    input_order: { required: ['images'] },
    output: [],
    output_name: [],
    name: 'PreviewImage',
    display_name: 'Preview Image',
    category: 'image',
  },
  LoraLoader: {
    input: {
      required: {
        model: ['MODEL'],
        clip: ['CLIP'],
        lora_name: [['detail.safetensors', 'style.safetensors'], { default: 'detail.safetensors' }],
        strength_model: ['FLOAT', { default: 1, min: -10, max: 10, step: 0.01 }],
        strength_clip: ['FLOAT', { default: 1, min: -10, max: 10, step: 0.01 }],
      },
    },
    input_order: { required: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'] },
    output: ['MODEL', 'CLIP'],
    output_name: ['MODEL', 'CLIP'],
    name: 'LoraLoader',
    display_name: 'Load LoRA',
    category: 'loaders',
  },
  ImageScale: {
    input: {
      required: {
        image: ['IMAGE'],
        upscale_method: [['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos'], {}],
        width: ['INT', { default: 1024, min: 0, max: 16384, step: 8 }],
        height: ['INT', { default: 1024, min: 0, max: 16384, step: 8 }],
        crop: [['disabled', 'center'], {}],
      },
    },
    input_order: { required: ['image', 'upscale_method', 'width', 'height', 'crop'] },
    output: ['IMAGE'],
    output_name: ['IMAGE'],
    name: 'ImageScale',
    display_name: 'Upscale Image',
    category: 'image',
  },
} as const;

function node(
  id: number,
  type: string,
  pos: [number, number],
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    pos,
    size: [315, 106],
    flags: {},
    order: id,
    mode: 0,
    inputs: [],
    outputs: [],
    properties: { 'Node name for S&R': type },
    widgets_values: [],
    ...options,
  };
}

export const mockUiWorkflow = {
  last_node_id: 7,
  last_link_id: 9,
  nodes: [
    node(1, 'CheckpointLoaderSimple', [80, 80], {
      title: 'Load Checkpoint',
      outputs: [
        { name: 'MODEL', type: 'MODEL', links: [3], slot_index: 0 },
        { name: 'CLIP', type: 'CLIP', links: [1, 2], slot_index: 1 },
        { name: 'VAE', type: 'VAE', links: [8], slot_index: 2 },
      ],
      widgets_values: ['sd_xl_base_1.0.safetensors'],
    }),
    node(2, 'CLIPTextEncode', [80, 260], {
      title: 'Positive Prompt',
      inputs: [{ name: 'clip', type: 'CLIP', link: 1 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4], slot_index: 0 }],
      widgets_values: ['a cozy cabin in the woods, cinematic light, highly detailed'],
    }),
    node(3, 'CLIPTextEncode', [80, 480], {
      title: 'Negative Prompt',
      inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5], slot_index: 0 }],
      widgets_values: ['blurry, low quality, watermark'],
    }),
    node(4, 'EmptyLatentImage', [80, 700], {
      title: 'Canvas Size',
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [6], slot_index: 0 }],
      widgets_values: [1024, 1024, 1],
    }),
    node(5, 'KSampler', [460, 260], {
      inputs: [
        { name: 'model', type: 'MODEL', link: 3 },
        { name: 'positive', type: 'CONDITIONING', link: 4 },
        { name: 'negative', type: 'CONDITIONING', link: 5 },
        { name: 'latent_image', type: 'LATENT', link: 6 },
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [7], slot_index: 0 }],
      widgets_values: [123456, 'fixed', 20, 7, 'euler', 'normal', 1],
    }),
    node(6, 'VAEDecode', [460, 560], {
      inputs: [
        { name: 'samples', type: 'LATENT', link: 7 },
        { name: 'vae', type: 'VAE', link: 8 },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9], slot_index: 0 }],
    }),
    node(7, 'SaveImage', [820, 560], {
      title: 'Save Image',
      inputs: [{ name: 'images', type: 'IMAGE', link: 9 }],
      widgets_values: ['ComfyUI'],
    }),
  ],
  links: [
    [1, 1, 1, 2, 0, 'CLIP'],
    [2, 1, 1, 3, 0, 'CLIP'],
    [3, 1, 0, 5, 0, 'MODEL'],
    [4, 2, 0, 5, 1, 'CONDITIONING'],
    [5, 3, 0, 5, 2, 'CONDITIONING'],
    [6, 4, 0, 5, 3, 'LATENT'],
    [7, 5, 0, 6, 0, 'LATENT'],
    [8, 1, 2, 6, 1, 'VAE'],
    [9, 6, 0, 7, 0, 'IMAGE'],
  ],
  groups: [],
  config: {},
  extra: {
    ds: { scale: 1, offset: [0, 0] },
    linearData: {
      inputs: [
        ['root:2:text', 'text', { description: '描述你想生成的画面' }],
        ['root:3:text', 'text', { description: '不希望出现的内容' }],
        ['root:5:seed', 'seed'],
        ['root:5:steps', 'steps'],
        ['root:5:cfg', 'cfg'],
        ['root:4:width', 'width'],
        ['root:4:height', 'height'],
        ['root:1:ckpt_name', 'ckpt_name'],
      ],
      outputs: ['root:7'],
    },
  },
  version: 0.4,
};

export const mockApiWorkflow = {
  '1': {
    class_type: 'CheckpointLoaderSimple',
    inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
    _meta: { title: 'Load Checkpoint' },
  },
  '2': {
    class_type: 'CLIPTextEncode',
    inputs: {
      text: 'a cozy cabin in the woods, cinematic light, highly detailed',
      clip: ['1', 1],
    },
    _meta: { title: 'Positive Prompt' },
  },
  '3': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'blurry, low quality, watermark', clip: ['1', 1] },
    _meta: { title: 'Negative Prompt' },
  },
  '4': {
    class_type: 'EmptyLatentImage',
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  '5': {
    class_type: 'KSampler',
    inputs: {
      seed: 123456,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['1', 0],
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
    },
  },
  '6': {
    class_type: 'VAEDecode',
    inputs: { samples: ['5', 0], vae: ['1', 2] },
  },
  '7': {
    class_type: 'SaveImage',
    inputs: { images: ['6', 0], filename_prefix: 'ComfyUI' },
  },
};

export const MOCK_WORKFLOWS: Record<string, unknown> = {
  'workflows/txt2img-ui.json': mockUiWorkflow,
  'workflows/txt2img-api.json': mockApiWorkflow,
};

export const MOCK_THUMBNAIL_PNG =
  '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';
