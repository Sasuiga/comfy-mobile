import type { WorkflowMedia } from '@comfy-mobile/shared';

/**
 * Output nodes are the most reliable signal. Custom pack names vary, so match
 * the save/preview verbs for each media kind instead of an exhaustive list.
 */
const VIDEO_OUTPUT =
  /savevideo|previewvideo|videocombine|video ?combine|savewebm|saveanimated|createvideo|vhs_/i;
const AUDIO_OUTPUT = /saveaudio|previewaudio|audiomp3|audioconcatenate|audioffmpeg/i;
const IMAGE_OUTPUT = /saveimage|previewimage|imagesave/i;

/** Generation/loader nodes that only appear in video or audio pipelines. */
const VIDEO_HINT = /video|animatediff|framepack|\bsvd\b|ltx|cosmos|mochi|interpolat/i;
const AUDIO_HINT = /audio|music|tts|vocoder|ace.?step|stable.?audio/i;

/** Last resort for workflows without a recognisable node (e.g. unknown packs). */
const NAME_VIDEO_HINT = /\b(video|i2v|t2v|wan|hunyuan|ltx|svd|animate|framepack|cosmos|mochi)\b/i;
const NAME_AUDIO_HINT = /\b(audio|music|tts|ace|voice)\b/i;

function classTypes(workflow: unknown): string[] {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return [];
  const record = workflow as Record<string, unknown>;
  const types: string[] = [];

  // UI format: nodes[{ type }]
  if (Array.isArray(record.nodes)) {
    for (const node of record.nodes) {
      if (!node || typeof node !== 'object') continue;
      const cls = (node as Record<string, unknown>).type;
      if (typeof cls === 'string') types.push(cls);
    }
    if (types.length) return types;
  }

  // API format: { id: { class_type } }
  for (const value of Object.values(record)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cls = (value as Record<string, unknown>).class_type;
    if (typeof cls === 'string') types.push(cls);
  }
  return types;
}

/**
 * Infer whether a workflow produces images, video or audio. Output nodes win
 * over other hints: many video workflows also save a still frame, and the video
 * is the artifact users are looking for.
 */
export function detectWorkflowMedia(workflow: unknown, hint = ''): WorkflowMedia {
  const types = classTypes(workflow);
  if (types.some((type) => VIDEO_OUTPUT.test(type))) return 'video';
  if (types.some((type) => AUDIO_OUTPUT.test(type))) return 'audio';
  if (types.some((type) => IMAGE_OUTPUT.test(type))) return 'image';
  if (types.some((type) => VIDEO_HINT.test(type))) return 'video';
  if (types.some((type) => AUDIO_HINT.test(type))) return 'audio';
  if (types.some((type) => /image/i.test(type))) return 'image';
  if (NAME_VIDEO_HINT.test(hint)) return 'video';
  if (NAME_AUDIO_HINT.test(hint)) return 'audio';
  return 'unknown';
}
