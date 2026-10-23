import type { FieldKind } from '@comfy-mobile/shared';
import { isFieldKind } from '@comfy-mobile/shared';

export interface MarkerInfo {
  exposed: boolean;
  hidden: boolean;
  label?: string;
  kind?: FieldKind;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  cleanTitle: string;
}

const NUMERIC_KINDS = new Set<FieldKind>(['number', 'slider']);

export function parseMarker(title: string | undefined | null): MarkerInfo {
  const source = typeof title === 'string' ? title : '';
  const info: MarkerInfo = {
    exposed: false,
    hidden: false,
    cleanTitle: source.trim(),
  };
  if (!source) return info;

  let found = false;
  let cleaned = source;

  const bracket = /\[UI([^\]]*)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = bracket.exec(source))) {
    found = true;
    const body = (match[1] ?? '').trim();
    applyBody(info, body);
  }

  // A short @ui alias for people who prefer node titles without brackets.
  const atUi = /(^|\s)@ui(?::([^\s]+))?/i;
  const atMatch = source.match(atUi);
  if (atMatch) {
    found = true;
    info.exposed = true;
    if (atMatch[2]) info.label = atMatch[2];
  }

  if (found) {
    cleaned = cleaned
      .replace(bracket, ' ')
      .replace(atUi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  info.cleanTitle = cleaned || source.trim();
  return info;
}

function applyBody(info: MarkerInfo, body: string): void {
  info.exposed = true;
  if (!body) return;

  if (/^hide$/i.test(body)) {
    info.hidden = true;
    info.exposed = false;
    return;
  }

  const group = body.match(/^group\s*[:=]\s*(.+)$/i);
  if (group) {
    info.group = group[1]!.trim();
    return;
  }

  if (body.startsWith(':')) {
    const label = body.slice(1).trim();
    if (label) info.label = label;
    return;
  }

  const labelWithColon = body.match(/^([^:]+):(.+)$/);
  if (labelWithColon && !NUMERIC_KINDS.has(labelWithColon[1] as FieldKind)) {
    const maybeKind = labelWithColon[1]!.trim().toLowerCase();
    if (!isFieldKind(maybeKind)) {
      info.label = labelWithColon[2]!.trim();
      return;
    }
  }

  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return;

  const first = tokens[0]!.toLowerCase();
  if (isFieldKind(first)) {
    info.kind = first;
  } else if (first === 'group' && tokens[1]) {
    info.group = tokens.slice(1).join(' ');
  } else {
    // [UI 正向提示词] is a convenient label shorthand.
    info.label = tokens.join(' ');
  }

  if (!info.kind || !NUMERIC_KINDS.has(info.kind)) return;
  const numbers = tokens
    .slice(1)
    .map((token) => Number(token))
    .filter((n) => Number.isFinite(n));
  if (numbers.length >= 1) info.min = numbers[0];
  if (numbers.length >= 2) info.max = numbers[1];
  if (numbers.length >= 3) info.step = numbers[2];
}
