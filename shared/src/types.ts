export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'select'
  | 'toggle'
  | 'image'
  | 'seed';

export type FieldSource = 'override' | 'linear' | 'marker' | 'heuristic';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldConstraints {
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  options?: FieldOption[];
  multiline?: boolean;
  maxLength?: number;
}

export interface Field {
  key: string;
  nodeId: string;
  input: string;
  widgetName: string;
  kind: FieldKind;
  label: string;
  description?: string;
  group: string;
  order: number;
  required: boolean;
  default?: unknown;
  constraints: FieldConstraints;
  visible: boolean;
  advanced: boolean;
  source: FieldSource;
  overridden?: boolean;
}

export interface FieldGroup {
  id: string;
  label: string;
  order: number;
  collapsed?: boolean;
}

export interface FieldOverride {
  key: string;
  label?: string;
  description?: string;
  kind?: FieldKind;
  group?: string;
  order?: number;
  visible?: boolean;
  advanced?: boolean;
}

export interface FormOverrides {
  version: 1;
  fields: FieldOverride[];
  updatedAt: string;
}

export type WorkflowFormat = 'ui' | 'api';

export interface WorkflowSummary {
  key: string;
  name: string;
  path: string;
  format?: WorkflowFormat;
  hasAppConfig?: boolean;
  mtime?: number;
  size?: number;
  source: 'remote' | 'imported';
  fieldCount?: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  fields: Field[];
  groups: FieldGroup[];
  warnings: string[];
  staleOverrides: string[];
  missingNodeTypes: { nodeId: string; classType: string; warning: string }[];
}

export interface Preset {
  id: string;
  workflowKey: string;
  name: string;
  values: Record<string, unknown>;
  randomizeSeeds?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SavePresetRequest {
  name: string;
  values: Record<string, unknown>;
  randomizeSeeds?: boolean;
}

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface RunProgress {
  value: number;
  max: number;
  percent: number;
  nodeId?: string;
  nodeLabel?: string;
  message?: string;
}

export type OutputKind = 'image' | 'video' | 'audio' | 'file';

export interface RunOutput {
  key: string;
  nodeId: string;
  kind: OutputKind;
  filename: string;
  subfolder: string;
  comfyType: string;
  contentType?: string;
  width?: number;
  height?: number;
}

export interface RunError {
  code: string;
  message: string;
  details?: unknown;
}

export interface RunRecord {
  id: string;
  promptId?: string;
  workflowKey: string;
  workflowName: string;
  state: RunState;
  progress: RunProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  values: Record<string, unknown>;
  resolvedSeeds: Record<string, number>;
  outputs: RunOutput[];
  error?: RunError;
  queuePosition?: number;
  nodeLabels?: Record<string, string>;
}

export interface RunSummary {
  id: string;
  promptId?: string;
  workflowKey: string;
  workflowName: string;
  state: RunState;
  createdAt: string;
  finishedAt?: string;
  thumbnail?: string;
  outputCount: number;
  errorMessage?: string;
}

export interface SubmitRunRequest {
  workflowKey: string;
  values: Record<string, unknown>;
  presetId?: string;
  randomizeSeeds?: boolean;
}

export interface SubmitRunResponse {
  runId: string;
  promptId: string;
  resolvedSeeds: Record<string, number>;
  warnings?: string[];
}

export interface RunEvent {
  type: 'snapshot' | 'update' | 'done' | 'error';
  run: RunRecord;
}

export interface ComfyCapabilities {
  userdata: boolean;
  prompt: boolean;
  websocket: boolean;
  historyV2: boolean;
  jobs: boolean;
  uploadAssetHash: boolean;
  systemStats: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  comfyVersion?: string;
  workflowCount?: number;
  capabilities: ComfyCapabilities;
  error?: string;
  warning?: string;
}

export interface AppConfigPublic {
  comfyUrl: string;
  hasToken: boolean;
  tokenSource: 'env' | 'config' | 'none';
  locked: {
    comfyUrl: boolean;
    token: boolean;
  };
  connected: boolean;
  comfyVersion?: string;
  capabilities?: ComfyCapabilities;
  setupRequired: boolean;
  maxUploadMb: number;
}

export interface UpdateConfigRequest {
  comfyUrl?: string;
  token?: string | null;
  headers?: Record<string, string> | null;
  insecure?: boolean;
}

export interface TestConnectionRequest {
  comfyUrl?: string;
  token?: string | null;
  headers?: Record<string, string> | null;
  insecure?: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ImportWorkflowRequest {
  name?: string;
  workflow: unknown;
}

export interface UploadResponse {
  name: string;
  subfolder: string;
  type: string;
  assetHash?: string;
  previewUrl?: string;
}

export interface WorkflowSaveFieldsRequest {
  fields: FieldOverride[];
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
}

export interface VersionResponse {
  name: string;
  version: string;
}
