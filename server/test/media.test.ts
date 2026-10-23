import { describe, expect, it } from 'vitest';
import { detectWorkflowMedia } from '../src/workflows/media.js';

function ui(...types: string[]) {
  return { nodes: types.map((type, index) => ({ id: index + 1, type })) };
}

describe('workflow media detection', () => {
  it('detects image workflows from their save node', () => {
    expect(detectWorkflowMedia(ui('CheckpointLoaderSimple', 'KSampler', 'SaveImage'))).toBe(
      'image',
    );
    expect(detectWorkflowMedia(ui('LoadImage', 'PreviewImage'))).toBe('image');
  });

  it('detects video workflows from output nodes', () => {
    expect(detectWorkflowMedia(ui('WanImageToVideo', 'KSampler', 'SaveVideo'))).toBe('video');
    expect(detectWorkflowMedia(ui('AnimateDiffLoader', 'VHS_VideoCombine'))).toBe('video');
  });

  it('prefers video when a workflow also saves still frames', () => {
    expect(
      detectWorkflowMedia(ui('AnimateDiffLoader', 'SaveImage', 'VHS_VideoCombine')),
    ).toBe('video');
  });

  it('detects audio workflows from save nodes and hints', () => {
    expect(detectWorkflowMedia(ui('LoadAudio', 'ACE_Step', 'SaveAudio'))).toBe('audio');
    expect(detectWorkflowMedia(ui('EmptyLatentAudio', 'MusicGen'))).toBe('audio');
  });

  it('falls back to generation hints and the name', () => {
    expect(detectWorkflowMedia(ui('LTXVConditioning', 'VAEDecode', 'ImageScale'))).toBe('video');
    expect(detectWorkflowMedia(ui('SomeCustomNode'), 'my-wan-i2v-workflow')).toBe('video');
    expect(detectWorkflowMedia(ui('SomeCustomNode'), 'podcast-tts')).toBe('audio');
  });

  it('reads API-format prompts and reports unknown when nothing matches', () => {
    const prompt = {
      '1': { class_type: 'WanImageToVideo', inputs: {} },
      '2': { class_type: 'SaveVideo', inputs: {} },
    };
    expect(detectWorkflowMedia(prompt)).toBe('video');

    expect(detectWorkflowMedia({ nodes: [] }, 'plain')).toBe('unknown');
    expect(detectWorkflowMedia(null)).toBe('unknown');
  });
});
