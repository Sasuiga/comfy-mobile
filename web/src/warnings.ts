import type { WorkflowDetail } from '@comfy-mobile/shared';

export type WarningKind = 'shift' | 'param' | 'asset' | 'node' | 'wiring' | 'other';
export type WarningSeverity = 'danger' | 'warn' | 'info';

export interface ParsedWarning {
  raw: string;
  kind: WarningKind;
  severity: WarningSeverity;
  nodeId?: string;
  classType?: string;
  /** Widget/input name for parameter and asset warnings. */
  field?: string;
  /** Value saved in the workflow. */
  savedValue?: string;
  /** Valid value the converter substituted. */
  replacement?: string;
  /** True when the saved value is an empty placeholder such as "None". */
  placeholder?: boolean;
  /** True for UI-only helper nodes (labels, group bypassers, notes, ...). */
  uiOnly?: boolean;
}

export interface NodeIssueCount {
  nodeId: string;
  classType: string;
  count: number;
}

export interface NodeTypeCount {
  classType: string;
  count: number;
  uiOnly: boolean;
}

export interface ParsedWarnings {
  items: ParsedWarning[];
  counts: {
    shift: number;
    param: number;
    asset: number;
    placeholder: number;
    node: number;
    wiring: number;
    other: number;
  };
  nodeTypes: NodeTypeCount[];
  shiftNodes: NodeIssueCount[];
  paramNodes: NodeIssueCount[];
  /** True when several enum values on one node were replaced — the usual
   * signature of a workflow saved against a different node version. */
  suspiciousShift: boolean;
  headline: string;
  severity: WarningSeverity;
}

const NODE_PREFIX = /^Node (\S+) \((.+?)\): (.*)$/;
const UI_ONLY_NODE =
  /^(Label|Fast Groups (?:Bypasser|Muter)) \(rgthree\)$|^(Note|MarkdownNote|Reroute|PrimitiveNode)$/;

function isPlaceholderValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'None' || trimmed === 'null' || trimmed === 'undefined';
}

function parseOne(raw: string): ParsedWarning {
  const prefix = NODE_PREFIX.exec(raw);
  const nodeId = prefix?.[1];
  const classType = prefix?.[2];
  const body = prefix?.[3] ?? raw;
  const base = { raw, nodeId, classType };

  // Widget slots that could not be mapped at all — usually the whole node is
  // reading one or more positions early. This is the one warning that makes a
  // workflow unsafe to run.
  if (/remain unmapped|reading one position early|may be shifted|skipped serialized value/i.test(body)) {
    return { ...base, kind: 'shift', severity: 'danger' };
  }

  const enumMatch =
    /^widget "(.+?)" value "(.*?)" is not a valid option on the connected server — substituting the first available option "(.*?)"/.exec(
      body,
    );
  if (enumMatch) {
    return {
      ...base,
      kind: 'param',
      severity: 'warn',
      field: enumMatch[1],
      savedValue: enumMatch[2],
      replacement: enumMatch[3],
    };
  }

  if (/^widget "(.+?)" saved selection "(.*?)" is no longer an available option/.test(body)) {
    return { ...base, kind: 'param', severity: 'warn' };
  }

  const assetMatch =
    /^widget "(.+?)" value "(.*?)" is not installed on the connected server/.exec(body);
  if (assetMatch) {
    return {
      ...base,
      kind: 'asset',
      severity: 'warn',
      field: assetMatch[1],
      savedValue: assetMatch[2],
      placeholder: isPlaceholderValue(assetMatch[2]),
    };
  }

  const emptyMatch =
    /^widget "(.+?)" value "(.*?)" — the connected server (?:has no installed options|lists no options)/.exec(
      body,
    );
  if (emptyMatch) {
    return {
      ...base,
      kind: 'asset',
      severity: 'warn',
      field: emptyMatch[1],
      savedValue: emptyMatch[2],
      placeholder: isPlaceholderValue(emptyMatch[2]),
    };
  }

  if (/^not found in object_info/.test(body)) {
    const uiOnly = Boolean(classType && UI_ONLY_NODE.test(classType));
    return { ...base, kind: 'node', severity: uiOnly ? 'info' : 'warn', uiOnly };
  }

  if (
    /source node is muted|were dropped|type-mismatched link|cg-use-everywhere|connection is ABSENT|left UNCONNECTED|could not be resolved|could not be matched|could not be applied|could NOT be applied|wiring/i.test(
      body,
    ) ||
    /\bComponent\b|subgraph|expansion/i.test(body)
  ) {
    return { ...base, kind: 'wiring', severity: 'info' };
  }

  return { ...base, kind: 'other', severity: 'info' };
}

function countNodeIssues(items: ParsedWarning[]): NodeIssueCount[] {
  const map = new Map<string, NodeIssueCount>();
  for (const item of items) {
    const nodeId = item.nodeId ?? '';
    const classType = item.classType ?? '';
    const key = `${nodeId}\u0000${classType}`;
    const entry = map.get(key) ?? { nodeId, classType, count: 0 };
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function countNodeTypes(items: ParsedWarning[]): NodeTypeCount[] {
  const map = new Map<string, NodeTypeCount>();
  for (const item of items) {
    const classType = item.classType?.trim();
    if (!classType) continue;
    const entry = map.get(classType) ?? {
      classType,
      count: 0,
      uiOnly: Boolean(item.uiOnly),
    };
    entry.count += 1;
    map.set(classType, entry);
  }
  return [...map.values()].sort(
    (a, b) =>
      Number(a.uiOnly) - Number(b.uiOnly) ||
      b.count - a.count ||
      a.classType.localeCompare(b.classType),
  );
}

function plural(count: number, one: string, many = `${one}`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The converter emits human-readable English strings. Turn them into a small
 * set of categories so the mobile UI can lead with what actually matters and
 * keep the raw text available on demand.
 */
export function parseWorkflowWarnings(
  warnings: string[],
  missingNodeTypes: WorkflowDetail['missingNodeTypes'] = [],
): ParsedWarnings {
  const rawList: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...warnings, ...missingNodeTypes.map((item) => item.warning)]) {
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    rawList.push(raw);
  }

  const items = rawList.map(parseOne);
  const shiftItems = items.filter((item) => item.kind === 'shift');
  const paramItems = items.filter((item) => item.kind === 'param');
  const assetItems = items.filter((item) => item.kind === 'asset');
  const nodeItems = items.filter((item) => item.kind === 'node');
  const wiringItems = items.filter((item) => item.kind === 'wiring');
  const otherItems = items.filter((item) => item.kind === 'other');

  const nodeTypes = countNodeTypes(nodeItems);
  const shiftNodes = countNodeIssues(shiftItems);
  const paramNodes = countNodeIssues(paramItems);
  const suspiciousShift = shiftNodes.length > 0 || paramNodes.some((node) => node.count >= 3);

  const placeholder = assetItems.filter((item) => item.placeholder).length;
  const realAssets = assetItems.length - placeholder;
  const nonUiTypes = nodeTypes.filter((type) => !type.uiOnly);
  const uiOnlyTypes = nodeTypes.filter((type) => type.uiOnly);

  const severity: WarningSeverity = suspiciousShift
    ? 'danger'
    : paramItems.length || realAssets || nonUiTypes.length
      ? 'warn'
      : 'info';

  let headline: string;
  if (shiftNodes.length) {
    const nodeText =
      shiftNodes.length === 1
        ? `Node ${shiftNodes[0]?.nodeId || ''} 参数错位`
        : `${shiftNodes.length} 个节点参数错位`;
    const extras: string[] = [];
    if (realAssets) extras.push(`${realAssets} 个资源缺失`);
    if (nonUiTypes.length) extras.push(`${nonUiTypes.length} 种节点未安装`);
    headline = `${nodeText}，运行前请重新保存工作流${extras.length ? `；另有 ${extras.join('、')}` : ''}`;
  } else if (suspiciousShift) {
    const node = paramNodes.find((item) => item.count >= 3);
    headline = `Node ${node?.nodeId || ''} 有 ${node?.count ?? 0} 项参数被替换，疑似参数错位`;
  } else {
    const parts: string[] = [];
    if (paramItems.length) parts.push(`${paramItems.length} 项参数被替换`);
    if (realAssets) parts.push(`${realAssets} 个资源缺失`);
    if (nonUiTypes.length) parts.push(`${nonUiTypes.length} 种节点未安装`);
    if (uiOnlyTypes.length) {
      const total = uiOnlyTypes.reduce((sum, type) => sum + type.count, 0);
      parts.push(`${total} 个界面节点未安装`);
    }
    if (wiringItems.length) parts.push(`${wiringItems.length} 条连线/结构提示`);
    if (otherItems.length) parts.push(`${otherItems.length} 条其它提示`);
    headline = parts.length ? parts.join(' · ') : plural(items.length, '条提示');
  }

  return {
    items,
    counts: {
      shift: shiftItems.length,
      param: paramItems.length,
      asset: realAssets,
      placeholder,
      node: nodeItems.length,
      wiring: wiringItems.length,
      other: otherItems.length,
    },
    nodeTypes,
    shiftNodes,
    paramNodes,
    suspiciousShift,
    headline,
    severity,
  };
}
