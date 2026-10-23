export interface LinearInput {
  nodeId: string;
  widgetName: string;
  description?: string;
  height?: number;
  widgetId?: string;
}

export interface LinearData {
  inputs: LinearInput[];
  outputs: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function deriveFromLocator(locator: string, widgetName?: string): { nodeId: string; widgetName: string } | undefined {
  let rest = locator;
  if (widgetName && rest.endsWith(`:${widgetName}`)) {
    rest = rest.slice(0, -1 - widgetName.length);
  }
  const parts = rest.split(':').filter(Boolean);
  if (!parts.length) return undefined;
  const nodeId = parts[parts.length - 1]!;
  const name = widgetName ?? locator.split(':').pop();
  if (!name) return undefined;
  return { nodeId, widgetName: name };
}

function parseInputEntry(entry: unknown): LinearInput | undefined {
  if (typeof entry === 'string') {
    const derived = deriveFromLocator(entry);
    return derived ? { ...derived, widgetId: entry } : undefined;
  }
  if (Array.isArray(entry)) {
    const locator = entry[0];
    const widgetName = typeof entry[1] === 'string' ? entry[1] : undefined;
    const config = asRecord(entry[2]);
    if (typeof locator === 'string') {
      const derived = deriveFromLocator(locator, widgetName);
      if (!derived) return undefined;
      return {
        ...derived,
        widgetId: locator,
        description: typeof config?.description === 'string' ? config.description : undefined,
        height: typeof config?.height === 'number' ? config.height : undefined,
      };
    }
    if (typeof locator === 'number' || typeof locator === 'bigint') {
      if (!widgetName) return undefined;
      return {
        nodeId: String(locator),
        widgetName,
        description: typeof config?.description === 'string' ? config.description : undefined,
        height: typeof config?.height === 'number' ? config.height : undefined,
      };
    }
    const record = asRecord(locator);
    if (record) {
      const nodeId =
        typeof record.nodeId === 'string' || typeof record.nodeId === 'number'
          ? String(record.nodeId)
          : undefined;
      const name =
        widgetName ??
        (typeof record.widgetName === 'string' ? record.widgetName : undefined) ??
        (typeof record.widget === 'string' ? record.widget : undefined);
      if (nodeId && name) {
        return { nodeId, widgetName: name, description: config?.description as string | undefined };
      }
    }
    return undefined;
  }
  const record = asRecord(entry);
  if (!record) return undefined;
  const nodeId =
    typeof record.nodeId === 'string' || typeof record.nodeId === 'number'
      ? String(record.nodeId)
      : undefined;
  const widgetName =
    typeof record.widgetName === 'string'
      ? record.widgetName
      : typeof record.widget === 'string'
        ? record.widget
        : typeof record.name === 'string'
          ? record.name
          : undefined;
  if (!nodeId || !widgetName) return undefined;
  return {
    nodeId,
    widgetName,
    widgetId: typeof record.widgetId === 'string' ? record.widgetId : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    height: typeof record.height === 'number' ? record.height : undefined,
  };
}

/**
 * Parse ComfyUI App Builder data. The current shape is:
 *   extra.linearData = { inputs: [[widgetId, widgetName, config?], ...], outputs: [...] }
 * Older / hand-written data with plain node ids is also accepted.
 */
export function parseLinearData(ui: unknown): LinearData | null {
  const root = asRecord(ui);
  if (!root) return null;
  const extra = asRecord(root.extra);
  let raw: unknown = extra?.linearData ?? extra?.linear_data ?? root.linearData;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const record = asRecord(raw);
  if (!record) return null;
  const rawInputs = Array.isArray(record.inputs) ? record.inputs : [];
  const inputs: LinearInput[] = [];
  const seen = new Set<string>();
  for (const entry of rawInputs) {
    const parsed = parseInputEntry(entry);
    if (!parsed) continue;
    const key = `${parsed.nodeId}.${parsed.widgetName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inputs.push(parsed);
  }
  if (!inputs.length && !Array.isArray(record.outputs)) return null;
  const outputs: string[] = [];
  if (Array.isArray(record.outputs)) {
    for (const output of record.outputs) {
      if (typeof output === 'string' || typeof output === 'number') {
        outputs.push(String(output));
      } else if (Array.isArray(output) && output.length) {
        const first = output[output.length - 1];
        if (typeof first === 'string' || typeof first === 'number') outputs.push(String(first));
      } else {
        const item = asRecord(output);
        if (item && (typeof item.nodeId === 'string' || typeof item.nodeId === 'number')) {
          outputs.push(String(item.nodeId));
        }
      }
    }
  }
  return { inputs, outputs };
}
