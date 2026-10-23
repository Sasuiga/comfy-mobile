export interface ConverterWarningNode {
  nodeId: string;
  classType: string;
  warning: string;
}

export interface ConvertResult {
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;
  warnings: string[];
  missingNodeTypes: ConverterWarningNode[];
  potentiallyExecutableNodeCount: number;
}

export function isUiFormat(obj: unknown): boolean;
export function isApiFormat(obj: unknown): boolean;
export function looksLikeAssetFilename(value: unknown): boolean;
export function collectNodeTypes(ui: Record<string, unknown>): Set<string>;
export function convertUiToApi(
  ui: Record<string, unknown>,
  objectInfo: Record<string, unknown>,
  options?: {
    frontendVirtualTypes?: Iterable<string>;
    [key: string]: unknown;
  },
): ConvertResult;
export const NON_EXECUTING_NODE_TYPES: Set<string>;
export const FRONTEND_ONLY_NODE_TYPES: Set<string>;
export const WIRING_VIRTUAL_TYPES: Set<string>;
