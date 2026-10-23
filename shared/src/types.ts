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
  /** Short context taken from the node title, e.g. "Krea 官方". */
  nodeTitle?: string;
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
  /** ComfyUI class type of the node that owns this field. */
  nodeClass?: string;
  /**
   * True for image/video/audio loader slots. Cancelling the slot bypasses the
   * loader node, so no file has to be supplied.
   */
  skippable?: boolean;
  /**
   * True when the whole node can be bypassed from the form: every consumer
   * either treats the input as optional or has a matching linked input that
   * can be passed through (the same rule ComfyUI's bypass mode follows).
   */
  nodeBypassable?: boolean;
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

/** Primary output of a workflow, inferred from its output nodes. */
export type WorkflowMedia = 'image' | 'video' | 'audio' | 'unknown';

export interface WorkflowSummary {
  key: string;
  name: string;
  path: string;
  format?: WorkflowFormat;
  /** Used by the picker to separate image, video and audio workflows. */
  media?: WorkflowMedia;
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
  /** Path relative to the project root, set after the file is archived. */
  assetPath?: string;
  /** Why archiving failed; the ComfyUI copy is still available. */
  archiveError?: string;
}

export type AssetKind = 'image' | 'video' | 'audio' | 'file';

/** Folder that collects runs and assets without an explicit project. */
export const DEFAULT_PROJECT = '默认项目';

/** A project is a folder under the project root holding inputs/ and outputs/. */
export interface ProjectSummary {
  /** Path relative to the project root, e.g. "20261023-秋季海报" or "默认项目". */
  path: string;
  /** Folder name on disk, including any YYYYMMDD- prefix. */
  name: string;
  /** Display title with the date prefix removed. */
  title: string;
  /** Creation date parsed from the folder prefix, e.g. "2026-10-23". */
  createdDate?: string;
  isDefault?: boolean;
  inputCount: number;
  outputCount: number;
  /** Root-relative path of the newest image output. */
  cover?: string;
  updatedAt: number;
  createdAt?: number;
}

export interface ProjectListResponse {
  /** Absolute path of the project root. */
  root: string;
  fallback: boolean;
  warning?: string;
  items: ProjectSummary[];
}

/** A file in the asset workspace, referenced from a workflow input. */
export interface AssetRef {
  /** Path relative to the project root, e.g. "项目A/inputs/photo.png". */
  path: string;
  name?: string;
  kind?: AssetKind;
}

export interface AssetEntry {
  name: string;
  /** Path relative to the project root. */
  path: string;
  kind: AssetKind;
  size: number;
  modified: number;
  contentType?: string;
}

export interface AssetDirEntry {
  name: string;
  /** Path relative to the project root. */
  path: string;
}

export interface AssetListResponse {
  /** Directory that was listed, relative to the project root. */
  path: string;
  parent?: string;
  dirs: AssetDirEntry[];
  files: AssetEntry[];
}

export interface AssetBrowseResponse {
  /** Directory relative to the browse root. */
  path: string;
  parent?: string;
  dirs: AssetDirEntry[];
}

export interface AssetStorageInfo {
  /** Root that the settings directory picker browses. */
  browseRoot: string;
  browseRootName: string;
  /** Project root directory relative to the browse root. */
  workspace: string;
  /** Absolute path of the project root. */
  workspacePath: string;
  /** True when the platform directory was unavailable and a local fallback is used. */
  fallback: boolean;
  warning?: string;
}

export function isAssetRef(value: unknown): value is AssetRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const path = (value as Record<string, unknown>).path;
  return typeof path === 'string' && path.length > 0 && path.length <= 1024;
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
  /** Project that owns the run; missing on records from before projects. */
  project?: string;
  state: RunState;
  progress: RunProgress;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  values: Record<string, unknown>;
  resolvedSeeds: Record<string, number>;
  outputs: RunOutput[];
  /** Node ids the user bypassed for this run. */
  bypassedNodes?: string[];
  error?: RunError;
  queuePosition?: number;
  nodeLabels?: Record<string, string>;
}

export interface RunSummary {
  id: string;
  promptId?: string;
  workflowKey: string;
  workflowName: string;
  project?: string;
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
  /** Project folder under the project root; defaults to 默认项目. */
  project?: string;
  presetId?: string;
  randomizeSeeds?: boolean;
  /** Node ids to bypass for this run (ComfyUI bypass semantics). */
  bypass?: string[];
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

export interface WorkflowTemplate {
  /** ComfyUI template id; also the file name under /templates. */
  name: string;
  title: string;
  description?: string;
  /** Template browser group, e.g. Image / Video / Audio. */
  category: string;
  tags: string[];
  models: string[];
  mediaType?: string;
  /** Templates built on Comfy API nodes need a comfy.org API key. */
  requiresApi: boolean;
}

export interface ListTemplatesResponse {
  items: WorkflowTemplate[];
  fetchedAt: string;
}

export interface ImportTemplateRequest {
  name: string;
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
