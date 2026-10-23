import { constants } from 'node:fs';
import { createWriteStream } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DEFAULT_PROJECT,
  buildProjectFolderName,
  parseProjectFolderName,
  type AssetBrowseResponse,
  type AssetEntry,
  type AssetKind,
  type AssetListResponse,
  type AssetStorageInfo,
  type ProjectListResponse,
  type ProjectSummary,
} from '@comfy-mobile/shared';
import type { ConfigService } from '../config.js';
import { AppError } from '../errors.js';
import { safeFilename } from '../security.js';

const DEFAULT_WORKSPACE = 'ComfyMobile';
const BASE_DIRS = ['inputs', 'outputs'] as const;
const MAX_LIST_ENTRIES = 1000;
const PROJECT_CACHE_MS = 10_000;
const PROJECT_SCAN_LIMIT = 1000;
const RESERVED_PROJECT_NAMES = new Set(['inputs', 'outputs']);
const RESERVED_PROJECT_TITLES = new Set([...RESERVED_PROJECT_NAMES, DEFAULT_PROJECT]);
const PROJECT_NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
/** Keeps the dated folder name (9 extra characters) within the path limit. */
const MAX_PROJECT_TITLE_LENGTH = 71;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  m4v: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

export function assetKind(filename: string): AssetKind {
  const ext = extname(filename).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'].includes(ext)) {
    return 'image';
  }
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'file';
}

export function assetMime(filename: string): string | undefined {
  return MIME_BY_EXTENSION[extname(filename).slice(1).toLowerCase()];
}

/** Normalize a path relative to a root; rejects traversal and absolute paths. */
export function normalizeAssetPath(input: string, allowEmpty = true): string {
  if (typeof input !== 'string' || input.length > 1024) {
    throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
  }
  if (/[\u0000-\u001f\u007f]/.test(input) || input.includes('\\')) {
    throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
  }
  const trimmed = input.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) {
    if (allowEmpty) return '';
    throw new AppError(400, 'INVALID_ASSET_PATH', '请选择素材目录');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
  }
  return parts.join('/');
}

/**
 * Maps paths from the pre-project layout (inputs/…, outputs/…) into the
 * default project, so old run records and asset references keep working.
 */
export function canonicalAssetPath(input: string, allowEmpty = true): string {
  const normalized = normalizeAssetPath(input, allowEmpty);
  if (!normalized) return normalized;
  const first = normalized.split('/')[0];
  if (first === 'inputs' || first === 'outputs') {
    return `${DEFAULT_PROJECT}/${normalized}`;
  }
  return normalized;
}

/** Validates the display name typed by the user before adding a date prefix. */
function normalizeProjectTitle(input: string): string {
  if (typeof input !== 'string') {
    throw new AppError(400, 'INVALID_PROJECT_NAME', '项目名称不合法');
  }
  const name = input.trim();
  if (
    !name ||
    name.length > MAX_PROJECT_TITLE_LENGTH ||
    name.startsWith('.') ||
    PROJECT_NAME_FORBIDDEN.test(name) ||
    RESERVED_PROJECT_TITLES.has(name)
  ) {
    throw new AppError(400, 'INVALID_PROJECT_NAME', '项目名称不合法');
  }
  return name;
}

/** Validates a single project folder name under the project root. */
export function normalizeProjectPath(input: string): string {
  if (typeof input !== 'string') {
    throw new AppError(400, 'INVALID_PROJECT_NAME', '项目名称不合法');
  }
  const name = input.trim();
  if (
    !name ||
    name.length > 80 ||
    name.startsWith('.') ||
    PROJECT_NAME_FORBIDDEN.test(name) ||
    RESERVED_PROJECT_NAMES.has(name)
  ) {
    throw new AppError(400, 'INVALID_PROJECT_NAME', '项目名称不合法');
  }
  return normalizeAssetPath(name, false);
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function parentPath(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  if (index < 0) return undefined;
  return path.slice(0, index);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function friendlyFsError(error: unknown, action: string): AppError {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    return new AppError(404, 'ASSET_NOT_FOUND', '素材不存在或已被删除');
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AppError(403, 'ASSET_FORBIDDEN', `没有权限${action}该素材目录`);
  }
  if (error instanceof AppError) return error;
  return new AppError(
    500,
    'ASSET_STORAGE_ERROR',
    `${action}素材时出错：${error instanceof Error ? error.message : String(error)}`,
  );
}

export interface ArchivedOutputOptions {
  runId: string;
  workflowName: string;
  filename: string;
  key: string;
  at: Date;
  /** Project folder under the project root; defaults to 默认项目. */
  project?: string;
}

export class AssetStore {
  private rootPath = '';
  private rootFallback = false;
  private rootWarning?: string;
  private projectCache?: { at: number; value: ProjectListResponse };

  constructor(private readonly config: ConfigService) {}

  async init(): Promise<void> {
    const configured = this.config.options.assetRootEnv;
    const fallback = resolve(this.config.options.dataDir, 'assets');
    const candidates: Array<{ path: string; fallback: boolean }> = [];
    if (configured) candidates.push({ path: resolve(configured), fallback: false });
    candidates.push({ path: fallback, fallback: true });

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await mkdir(candidate.path, { recursive: true });
        await access(candidate.path, constants.R_OK | constants.W_OK);
        const realRoot = await realpath(candidate.path);
        const workspace = this.resolveLexical(realRoot, this.workspace);
        await mkdir(workspace, { recursive: true });
        const realWorkspace = await realpath(workspace);
        if (!isInside(realRoot, realWorkspace)) {
          throw new Error('workspace resolves outside the asset root');
        }
        await this.ensureLayout(realWorkspace);
        this.rootPath = realRoot;
        this.rootFallback = candidate.fallback;
        this.rootWarning =
          candidate.fallback && configured
            ? `无法访问素材根目录 ${configured}，已改用应用本地目录`
            : undefined;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `无法初始化素材目录：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  get browseRoot(): string {
    return this.rootPath;
  }

  get workspace(): string {
    try {
      return normalizeAssetPath(this.config.assetWorkspace, false);
    } catch {
      return DEFAULT_WORKSPACE;
    }
  }

  get workspaceRoot(): string {
    return this.resolveLexical(this.rootPath, this.workspace);
  }

  info(): AssetStorageInfo {
    return {
      browseRoot: this.rootPath,
      browseRootName: basename(this.rootPath) || this.rootPath,
      workspace: this.workspace,
      workspacePath: this.workspaceRoot,
      fallback: this.rootFallback,
      warning: this.rootWarning,
    };
  }

  /** Lists projects (folders under the project root) with counts and covers. */
  async listProjects(): Promise<ProjectListResponse> {
    if (this.projectCache && Date.now() - this.projectCache.at < PROJECT_CACHE_MS) {
      return this.projectCache.value;
    }
    await this.ensureProject(DEFAULT_PROJECT);
    const root = await realpath(this.workspaceRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      throw friendlyFsError(error, '读取');
    }
    const items: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (RESERVED_PROJECT_NAMES.has(entry.name)) continue;
      try {
        items.push(await this.summarizeProject(entry.name));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw friendlyFsError(error, '读取');
      }
    }
    if (!items.some((item) => item.path === DEFAULT_PROJECT)) {
      items.push(await this.summarizeProject(DEFAULT_PROJECT));
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, 'zh-CN'));
    const value: ProjectListResponse = {
      root,
      fallback: this.rootFallback,
      warning: this.rootWarning,
      items,
    };
    this.projectCache = { at: Date.now(), value };
    return value;
  }

  async getProject(path: string): Promise<ProjectSummary> {
    const name = normalizeProjectPath(path);
    return this.summarizeProject(name);
  }

  async createProject(name: string): Promise<ProjectSummary> {
    const title = normalizeProjectTitle(name);
    const normalized = normalizeProjectPath(buildProjectFolderName(title));
    const root = await realpath(this.workspaceRoot);
    const target = this.resolveLexical(root, normalized);
    try {
      await mkdir(target);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new AppError(409, 'PROJECT_EXISTS', '已有同名项目');
      }
      throw friendlyFsError(error, '创建');
    }
    try {
      const realTarget = await realpath(target);
      if (!isInside(root, realTarget) || dirname(realTarget) !== root) {
        throw new AppError(400, 'INVALID_PROJECT_NAME', '项目路径不合法');
      }
      for (const dir of BASE_DIRS) {
        await mkdir(join(realTarget, dir), { recursive: true });
      }
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw friendlyFsError(error, '创建');
    }
    this.projectCache = undefined;
    return this.summarizeProject(normalized);
  }

  /** Creates the project folder and its inputs/outputs when missing. */
  async ensureProject(path: string): Promise<string> {
    const normalized = normalizeProjectPath(path || DEFAULT_PROJECT);
    const root = await realpath(this.workspaceRoot);
    const target = this.resolveLexical(root, normalized);
    try {
      await mkdir(target, { recursive: true });
      const realTarget = await realpath(target);
      if (!isInside(root, realTarget) || dirname(realTarget) !== root) {
        throw new AppError(400, 'INVALID_PROJECT_NAME', '项目路径不合法');
      }
      for (const dir of BASE_DIRS) {
        await mkdir(join(realTarget, dir), { recursive: true });
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw friendlyFsError(error, '创建');
    }
    return normalized;
  }

  async deleteProject(path: string): Promise<void> {
    const normalized = normalizeProjectPath(path);
    if (normalized === DEFAULT_PROJECT) {
      throw new AppError(400, 'DEFAULT_PROJECT_PROTECTED', '默认项目不能删除');
    }
    const root = await realpath(this.workspaceRoot);
    const target = this.resolveLexical(root, normalized);
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
      }
      throw friendlyFsError(error, '读取');
    }
    if (!isInside(root, realTarget) || dirname(realTarget) !== root || realTarget === root) {
      throw new AppError(400, 'INVALID_PROJECT_NAME', '项目路径不合法');
    }
    const info = await stat(realTarget).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
    }
    try {
      await rm(realTarget, { recursive: true, force: false });
    } catch (error) {
      throw friendlyFsError(error, '删除');
    }
    this.projectCache = undefined;
  }

  private invalidateProjects(): void {
    this.projectCache = undefined;
  }

  private async summarizeProject(name: string): Promise<ProjectSummary> {
    const root = await realpath(this.workspaceRoot);
    const dir = this.resolveLexical(root, name);
    let info;
    try {
      info = await stat(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
      }
      throw friendlyFsError(error, '读取');
    }
    if (!info.isDirectory()) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
    }
    const inputs = await this.scanProjectFolder(`${name}/inputs`, 3, false);
    const outputs = await this.scanProjectFolder(`${name}/outputs`, 4, true);
    const parsed = name === DEFAULT_PROJECT ? { title: name } : parseProjectFolderName(name);
    return {
      path: name,
      name,
      title: parsed.title,
      createdDate: parsed.createdDate,
      isDefault: name === DEFAULT_PROJECT,
      inputCount: inputs.count,
      outputCount: outputs.count,
      cover: outputs.newest,
      updatedAt: Math.max(info.mtimeMs, inputs.updatedAt, outputs.updatedAt),
      createdAt: info.birthtimeMs || info.ctimeMs,
    };
  }

  /**
   * Counts files below a project folder and, for outputs, remembers the
   * newest image for the project cover. Depth and entry limits keep a large
   * network folder from stalling the home screen.
   */
  private async scanProjectFolder(
    relative: string,
    maxDepth: number,
    collectCover: boolean,
  ): Promise<{ count: number; newest?: string; updatedAt: number }> {
    const root = await realpath(this.workspaceRoot);
    const base = this.resolveLexical(root, relative);
    const stack: Array<{ dir: string; rel: string; depth: number }> = [
      { dir: base, rel: relative, depth: 0 },
    ];
    let count = 0;
    let updatedAt = 0;
    let newest: { path: string; mtime: number } | undefined;
    while (stack.length) {
      const current = stack.pop();
      if (!current) break;
      let entries;
      try {
        entries = await readdir(current.dir, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw friendlyFsError(error, '读取');
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (count >= PROJECT_SCAN_LIMIT) break;
        const childRel = `${current.rel}/${entry.name}`;
        const childAbs = join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < maxDepth) {
            stack.push({ dir: childAbs, rel: childRel, depth: current.depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        count += 1;
        try {
          const item = await stat(childAbs);
          updatedAt = Math.max(updatedAt, item.mtimeMs);
          if (
            collectCover &&
            assetKind(entry.name) === 'image' &&
            item.mtimeMs > (newest?.mtime ?? 0)
          ) {
            newest = { path: childRel, mtime: item.mtimeMs };
          }
        } catch {
          // A file can disappear while scanning; skip it.
        }
      }
    }
    return { count, newest: newest?.path, updatedAt };
  }

  /**
   * Creates the default project and moves pre-project root inputs/outputs into
   * it. Called on startup and when the project root changes.
   */
  private async ensureLayout(workspaceRoot: string): Promise<void> {
    const defaultDir = join(workspaceRoot, DEFAULT_PROJECT);
    await mkdir(defaultDir, { recursive: true });
    const realDefault = await realpath(defaultDir);
    if (!isInside(workspaceRoot, realDefault)) {
      throw new AppError(400, 'INVALID_PROJECT_NAME', '默认项目路径不合法');
    }
    for (const dir of BASE_DIRS) {
      const legacy = join(workspaceRoot, dir);
      try {
        const info = await lstat(legacy);
        if (!info.isDirectory()) continue;
        const destination = join(realDefault, dir);
        await mkdir(destination, { recursive: true });
        await this.moveEntries(legacy, destination);
        const rest = await readdir(legacy);
        if (!rest.length) await rm(legacy, { recursive: true, force: true });
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        console.warn(`[assets] 迁移旧素材目录失败（${legacy}）：`, error);
      }
    }
    for (const dir of BASE_DIRS) {
      await mkdir(join(realDefault, dir), { recursive: true });
    }
  }

  /** Moves entries without overwriting same-named files in the destination. */
  private async moveEntries(fromDir: string, toDir: string): Promise<void> {
    const entries = await readdir(fromDir, { withFileTypes: true });
    for (const entry of entries) {
      const from = join(fromDir, entry.name);
      let to = join(toDir, entry.name);
      try {
        await access(to, constants.F_OK);
        to = join(toDir, await this.uniqueName(toDir, entry.name));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      try {
        await rename(from, to);
      } catch (error) {
        if (errorCode(error) !== 'EXDEV') throw error;
        await cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await rm(from, { recursive: true, force: true });
      }
    }
  }

  /** Lists subdirectories under the configured browse root for the settings picker. */
  async browseDirs(path: string): Promise<AssetBrowseResponse> {
    const normalized = normalizeAssetPath(path);
    const root = await realpath(this.rootPath);
    const target = this.resolveLexical(root, normalized);
    if (!isInside(root, target)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
    }
    let entries;
    try {
      const realTarget = await realpath(target);
      if (!isInside(root, realTarget)) {
        throw new AppError(400, 'INVALID_ASSET_PATH', '该目录指向素材根目录之外');
      }
      entries = await readdir(realTarget, { withFileTypes: true });
    } catch (error) {
      throw friendlyFsError(error, '读取');
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: normalized ? `${normalized}/${entry.name}` : entry.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return {
      path: normalized,
      parent: normalized ? parentPath(normalized) : undefined,
      dirs,
    };
  }

  async setWorkspace(path: string): Promise<AssetStorageInfo> {
    const normalized = normalizeAssetPath(path, false);
    const root = await realpath(this.rootPath);
    const target = this.resolveLexical(root, normalized);
    if (!isInside(root, target)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
    }
    try {
      await mkdir(target, { recursive: true });
      const realTarget = await realpath(target);
      if (!isInside(root, realTarget)) {
        throw new AppError(400, 'INVALID_ASSET_PATH', '该目录指向素材根目录之外');
      }
      await this.ensureLayout(realTarget);
    } catch (error) {
      throw friendlyFsError(error, '使用');
    }
    this.projectCache = undefined;
    await this.config.updateAssetWorkspace(normalized);
    return this.info();
  }

  /** Lists directories and files under a project-root-relative directory. */
  async list(path: string): Promise<AssetListResponse> {
    const normalized = canonicalAssetPath(path);
    const workspaceRoot = await realpath(this.workspaceRoot);
    const target = this.resolveLexical(workspaceRoot, normalized);
    if (!isInside(workspaceRoot, target)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
    }
    let entries;
    let realTarget: string;
    try {
      realTarget = await realpath(target);
      if (!isInside(workspaceRoot, realTarget)) {
        throw new AppError(400, 'INVALID_ASSET_PATH', '该目录指向项目根目录之外');
      }
      entries = await readdir(realTarget, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return {
          path: normalized,
          parent: normalized ? parentPath(normalized) : undefined,
          dirs: [],
          files: [],
        };
      }
      throw friendlyFsError(error, '读取');
    }

    const dirs: AssetListResponse['dirs'] = [];
    const files: AssetEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (dirs.length + files.length >= MAX_LIST_ENTRIES) break;
      const rel = normalized ? `${normalized}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: rel });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(join(realTarget, entry.name));
        files.push({
          name: entry.name,
          path: rel,
          kind: assetKind(entry.name),
          size: info.size,
          modified: info.mtimeMs,
          contentType: assetMime(entry.name),
        });
      } catch {
        // A file can disappear while listing; skip it.
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name, 'zh-CN'));
    return {
      path: normalized,
      parent: normalized ? parentPath(normalized) : undefined,
      dirs,
      files,
    };
  }

  async describe(path: string): Promise<AssetEntry> {
    const resolved = await this.resolveExisting(path);
    const info = await stat(resolved.abs);
    if (!info.isFile()) {
      throw new AppError(400, 'NOT_A_FILE', '请选择一个文件');
    }
    const name = basename(resolved.abs);
    return {
      name,
      path: resolved.rel,
      kind: assetKind(name),
      size: info.size,
      modified: info.mtimeMs,
      contentType: assetMime(name),
    };
  }

  async fileInfo(path: string): Promise<{
    abs: string;
    name: string;
    size: number;
    modified: number;
    contentType?: string;
  }> {
    const resolved = await this.resolveExisting(path);
    const info = await stat(resolved.abs);
    if (!info.isFile()) {
      throw new AppError(400, 'NOT_A_FILE', '请选择一个文件');
    }
    const name = basename(resolved.abs);
    return {
      abs: resolved.abs,
      name,
      size: info.size,
      modified: info.mtimeMs,
      contentType: assetMime(name),
    };
  }

  /** Reads a referenced file for upload to ComfyUI, with a cheap change signature. */
  async readForUpload(path: string): Promise<{
    buffer: Buffer;
    filename: string;
    mime: string;
    signature: string;
  }> {
    const resolved = await this.resolveExisting(path);
    const info = await stat(resolved.abs);
    if (!info.isFile()) {
      throw new AppError(400, 'NOT_A_FILE', '选择的素材不是文件');
    }
    const buffer = await readFile(resolved.abs);
    const filename = basename(resolved.abs);
    return {
      buffer,
      filename,
      mime: assetMime(filename) ?? 'application/octet-stream',
      signature: `${info.size}:${info.mtimeMs}`,
    };
  }

  /** Allocates a unique target name inside a project-root-relative directory. */
  async allocateUpload(
    dir: string,
    filename: string,
  ): Promise<{ abs: string; rel: string; name: string }> {
    const normalized = canonicalAssetPath(dir);
    const workspaceRoot = await realpath(this.workspaceRoot);
    const targetDir = this.resolveLexical(workspaceRoot, normalized);
    if (!isInside(workspaceRoot, targetDir)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
    }
    try {
      await mkdir(targetDir, { recursive: true });
      const realDir = await realpath(targetDir);
      if (!isInside(workspaceRoot, realDir)) {
        throw new AppError(400, 'INVALID_ASSET_PATH', '该目录指向项目根目录之外');
      }
      const name = await this.uniqueName(realDir, safeFilename(filename, 'upload'));
      this.invalidateProjects();
      return {
        abs: join(realDir, name),
        rel: normalized ? `${normalized}/${name}` : name,
        name,
      };
    } catch (error) {
      throw friendlyFsError(error, '写入');
    }
  }

  async saveUpload(dir: string, filename: string, data: Uint8Array): Promise<AssetEntry> {
    const target = await this.allocateUpload(dir, filename);
    try {
      await writeFile(target.abs, data, { flag: 'wx' });
    } catch (error) {
      throw friendlyFsError(error, '写入');
    }
    this.invalidateProjects();
    return this.describe(target.rel);
  }

  async delete(path: string): Promise<void> {
    const resolved = await this.resolveExisting(path);
    const workspaceRoot = await realpath(this.workspaceRoot);
    if (resolved.abs === workspaceRoot) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '不能删除项目根目录本身');
    }
    if (!resolved.rel.includes('/')) {
      throw new AppError(400, 'IS_PROJECT_DIRECTORY', '这是项目目录，请从项目列表删除');
    }
    try {
      await rm(resolved.abs, { recursive: true, force: true });
    } catch (error) {
      throw friendlyFsError(error, '删除');
    }
    this.invalidateProjects();
  }

  /**
   * Streams one ComfyUI output into <project>/outputs/YYYY/MM without loading
   * it into memory. Returns the path relative to the project root.
   */
  async archiveOutput(
    body: ReadableStream<Uint8Array> | null,
    options: ArchivedOutputOptions,
  ): Promise<string> {
    if (!body) {
      throw new Error('ComfyUI 没有返回文件内容');
    }
    const at = options.at;
    const year = String(at.getFullYear());
    const month = String(at.getMonth() + 1).padStart(2, '0');
    const project = normalizeProjectPath(options.project || DEFAULT_PROJECT);
    const dirRel = `${project}/outputs/${year}/${month}`;
    const workspaceRoot = await realpath(this.workspaceRoot);
    const targetDir = this.resolveLexical(workspaceRoot, dirRel);
    if (!isInside(workspaceRoot, targetDir)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
    }
    await mkdir(targetDir, { recursive: true });
    const realDir = await realpath(targetDir);
    if (!isInside(workspaceRoot, realDir)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '输出目录指向项目根目录之外');
    }

    const stamp =
      `${year}${month}${String(at.getDate()).padStart(2, '0')}-` +
      `${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}` +
      `${String(at.getSeconds()).padStart(2, '0')}`;
    const original = safeFilename(options.filename, 'output');
    const ext = extname(original).slice(0, 16);
    const stem = (original.slice(0, original.length - ext.length) || 'output').slice(0, 80);
    const prefix = `${stamp}_${options.runId.slice(0, 8)}_${options.key}`;
    const name = await this.uniqueName(realDir, `${prefix}_${stem}${ext}`);

    const target = join(realDir, name);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(
        Readable.fromWeb(body as never),
        createWriteStream(temp, { flags: 'wx' }),
      );
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw friendlyFsError(error, '保存输出');
    }
    this.invalidateProjects();
    return `${dirRel}/${name}`;
  }

  private resolveLexical(root: string, relative: string): string {
    const target = resolve(root, relative);
    if (!isInside(root, target)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '素材路径不合法');
    }
    return target;
  }

  private async resolveExisting(
    path: string,
  ): Promise<{ rel: string; abs: string }> {
    const normalized = canonicalAssetPath(path, false);
    const workspaceRoot = await realpath(this.workspaceRoot);
    const lexical = this.resolveLexical(workspaceRoot, normalized);
    let abs: string;
    try {
      abs = await realpath(lexical);
    } catch (error) {
      throw friendlyFsError(error, '读取');
    }
    if (!isInside(workspaceRoot, abs)) {
      throw new AppError(400, 'INVALID_ASSET_PATH', '该素材指向项目根目录之外');
    }
    return { rel: normalized, abs };
  }

  private async uniqueName(dir: string, filename: string): Promise<string> {
    const ext = extname(filename).slice(0, 20);
    const stem = (filename.slice(0, filename.length - ext.length) || 'file').slice(0, 120);
    for (let index = 0; index < 1000; index += 1) {
      const name = index === 0 ? `${stem}${ext}` : `${stem} (${index})${ext}`;
      try {
        await access(join(dir, name), constants.F_OK);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return name;
        throw friendlyFsError(error, '检查');
      }
    }
    return `${stem}-${Date.now().toString(36)}${ext}`;
  }
}
