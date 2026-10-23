import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  projectDisplayTitle,
  type AssetDirEntry,
  type AssetEntry,
  type AssetStorageInfo,
} from '@comfy-mobile/shared';
import { api, assetUrl, errorMessage, projectAssetDir } from '../api';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorBox,
  Modal,
  PageHeader,
  Spinner,
  usePageTitle,
} from '../components/UI';
import { zh } from '../i18n';

type AssetRoot = 'inputs' | 'outputs';

const ROOT_LABELS: Record<AssetRoot, string> = {
  inputs: '输入素材',
  outputs: '输出素材',
};

function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function timeText(modified: number): string {
  if (!Number.isFinite(modified) || modified <= 0) return '';
  const date = new Date(modified);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return sameYear ? `${month}-${day} ${hour}:${minute}` : `${date.getFullYear()}-${month}-${day}`;
}

export interface AssetsPageProps {
  /** When set, browse only this project's folder instead of the whole root. */
  project?: string;
  section?: AssetRoot;
  /** Embedded mode hides the page header, storage info and section tabs. */
  embedded?: boolean;
  allowUpload?: boolean;
  /** Called after uploads or deletions so the embedding page can refresh counts. */
  onChanged?: () => void;
}

export function AssetsPage({
  project,
  section = 'inputs',
  embedded = false,
  allowUpload = true,
  onChanged,
}: AssetsPageProps = {}) {
  usePageTitle(embedded && project ? projectDisplayTitle(project) : '素材库');
  const navigate = useNavigate();
  const { showToast } = useApp();
  const [info, setInfo] = useState<AssetStorageInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [root, setRoot] = useState<AssetRoot>(section);
  const basePath = embedded && project ? projectAssetDir(project, section) : root;
  const [dir, setDir] = useState<string>(basePath);
  const [dirs, setDirs] = useState<AssetDirEntry[]>([]);
  const [files, setFiles] = useState<AssetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [viewer, setViewer] = useState<AssetEntry | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listAssets(path);
      setDirs(response.dirs);
      setFiles(response.files);
    } catch (cause) {
      setError(errorMessage(cause));
      setDirs([]);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDir(basePath);
    setQuery('');
    setViewer(null);
    void load(basePath);
  }, [basePath, load]);

  useEffect(() => {
    if (embedded) return;
    void api
      .assetInfo()
      .then(setInfo)
      .catch((cause) => setInfoError(errorMessage(cause)));
  }, [embedded]);

  useEffect(() => {
    setRoot(section);
  }, [section]);

  const switchRoot = (next: AssetRoot): void => {
    setRoot(next);
    setDir(next);
    setQuery('');
    setViewer(null);
    void load(next);
  };

  const enterDir = (path: string): void => {
    setDir(path);
    setQuery('');
    void load(path);
  };

  const goUp = (): void => {
    if (dir === basePath) return;
    const index = dir.lastIndexOf('/');
    const parent = index >= 0 ? dir.slice(0, index) : '';
    enterDir(
      parent === basePath || parent.startsWith(`${basePath}/`) ? parent : basePath,
    );
  };

  const upload = async (list: FileList | null): Promise<void> => {
    const selected = Array.from(list ?? []);
    if (!selected.length) return;
    setUploading(true);
    let uploaded = 0;
    try {
      for (const file of selected) {
        await api.uploadAsset(file, dir);
        uploaded += 1;
      }
      showToast(`已上传 ${uploaded} 个素材`, 'success');
      await load(dir);
      onChanged?.();
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
      if (uploaded) await load(dir);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async (entry: AssetEntry): Promise<void> => {
    if (
      !window.confirm(
        `直接删除「${entry.name}」？\n文件会从素材目录中永久移除，无法恢复。`,
      )
    ) {
      return;
    }
    setDeleting(entry.path);
    try {
      await api.deleteAsset(entry.path);
      setFiles((items) => items.filter((item) => item.path !== entry.path));
      if (viewer?.path === entry.path) setViewer(null);
      showToast('已删除', 'success');
      onChanged?.();
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setDeleting(null);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => file.name.toLowerCase().includes(q));
  }, [files, query]);

  const media = visible.filter((file) => file.kind === 'image' || file.kind === 'video');
  const others = visible.filter((file) => file.kind !== 'image' && file.kind !== 'video');
  const filteredDirs = query.trim()
    ? dirs.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    : dirs;
  const empty = !filteredDirs.length && !visible.length;

  const relativePath =
    dir === basePath ? '' : dir.slice(basePath.length + 1);

  return (
    <div className={`page assets-page${embedded ? ' embedded' : ''}`}>
      {embedded ? null : (
        <PageHeader
          large
          title="素材库"
          subtitle={
            info ? (
              <span className="assets-storage-line" title={info.workspacePath}>
                <Icon name="folder" size={14} />
                {info.workspacePath}
              </span>
            ) : (
              '输入与输出素材'
            )
          }
          actions={
            <>
              <button
                type="button"
                className="icon-button bordered"
                title="上传素材"
                aria-label="上传素材"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
              >
                {uploading ? <Spinner size={18} /> : <Icon name="upload" />}
              </button>
              <button
                type="button"
                className="icon-button bordered"
                title={zh.common.refresh}
                aria-label={zh.common.refresh}
                disabled={loading}
                onClick={() => void load(dir)}
              >
                <Icon name="refresh" />
              </button>
            </>
          }
        />
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        hidden
        onChange={(event) => void upload(event.target.files)}
      />

      {!embedded && info?.fallback ? (
        <div className="asset-warning" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>素材目录暂不可用</strong>
            <p>{info.warning ?? '正在使用服务数据目录保存素材。'}</p>
          </div>
        </div>
      ) : null}

      {!embedded && infoError ? (
        <div className="asset-warning" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>无法读取素材存储设置</strong>
            <p>{infoError}</p>
          </div>
        </div>
      ) : null}

      {!embedded && info && !info.fallback ? (
        <button
          type="button"
          className="asset-storage-button"
          onClick={() => navigate('/settings')}
        >
          <span>
            <Icon name="folder" size={16} />
            素材目录
          </span>
          <strong>{info.workspace}</strong>
          <Icon name="chevron" size={16} />
        </button>
      ) : null}

      {embedded ? null : (
        <div className="segment-row asset-root-tabs">
          {(Object.keys(ROOT_LABELS) as AssetRoot[]).map((key) => (
            <button
              type="button"
              key={key}
              className={`segment${root === key ? ' active' : ''}`}
              onClick={() => switchRoot(key)}
            >
              {ROOT_LABELS[key]}
            </button>
          ))}
        </div>
      )}

      <div className="assets-toolbar">
        <button
          type="button"
          className="icon-button tiny"
          aria-label="上一级"
          disabled={dir === basePath}
          onClick={goUp}
        >
          <Icon name="back" size={16} />
        </button>
        <span className="assets-path" title={dir}>
          {embedded
            ? relativePath || ROOT_LABELS[section]
            : dir === basePath
              ? ROOT_LABELS[root]
              : dir}
        </span>
        {embedded && allowUpload ? (
          <button
            type="button"
            className="icon-button tiny"
            title="上传素材"
            aria-label="上传素材"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? <Spinner size={16} /> : <Icon name="upload" size={16} />}
          </button>
        ) : null}
        <div className="search-field grow">
          <Icon name="search" size={16} />
          <input
            value={query}
            placeholder="搜索当前文件夹"
            aria-label="搜索素材"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="clear-button"
              aria-label={zh.common.close}
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="loading-block"><Spinner size={26} label={zh.common.loading} /></div>
      ) : error ? (
        <ErrorBox message={error} onRetry={() => void load(dir)} />
      ) : empty ? (
        <EmptyState
          icon="image"
          title={query ? '没有匹配的素材' : '这个文件夹还是空的'}
          hint={
            query
              ? '换个关键词试试，或清空搜索。'
              : (embedded ? section : root) === 'outputs'
                ? '运行工作流生成的结果会自动归档到这里。'
                : '上传图片、视频或音频后，会保存在这里；运行工作流时也可以直接选用。'
          }
          action={
            query || !allowUpload ? undefined : (
              <button
                type="button"
                className="button primary"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
              >
                <Icon name="upload" size={18} />
                上传素材
              </button>
            )
          }
        />
      ) : (
        <>
          {filteredDirs.length ? (
            <section className="asset-section">
              <h2 className="section-label">文件夹</h2>
              <div className="asset-dir-list">
                {filteredDirs.map((item) => (
                  <button
                    type="button"
                    key={item.path}
                    className="asset-dir"
                    onClick={() => enterDir(item.path)}
                  >
                    <Icon name="folder" size={18} />
                    <span>{item.name}</span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {media.length ? (
            <section className="asset-section">
              <h2 className="section-label">
                图片与视频<span className="count">{media.length}</span>
              </h2>
              <div className="asset-grid">
                {media.map((item) => (
                  <article className="asset-card" key={item.path}>
                    {item.kind === 'image' ? (
                      <button
                        type="button"
                        className="asset-card-media"
                        onClick={() => setViewer(item)}
                      >
                        <img src={assetUrl(item.path)} alt={item.name} loading="lazy" />
                      </button>
                    ) : (
                      <div className="asset-card-media video">
                        <video
                          src={assetUrl(item.path)}
                          controls
                          playsInline
                          preload="metadata"
                        />
                      </div>
                    )}
                    <div className="asset-card-body">
                      <span className="asset-card-name" title={item.name}>{item.name}</span>
                      <span className="asset-card-meta">
                        {sizeText(item.size)}
                        {timeText(item.modified) ? ` · ${timeText(item.modified)}` : ''}
                      </span>
                    </div>
                    <div className="asset-card-actions">
                      <a
                        className="icon-button tiny"
                        href={assetUrl(item.path, true)}
                        download={item.name}
                        title="下载"
                        aria-label="下载"
                      >
                        <Icon name="download" size={16} />
                      </a>
                      <button
                        type="button"
                        className="icon-button tiny danger"
                        title={zh.common.delete}
                        aria-label={zh.common.delete}
                        disabled={deleting === item.path}
                        onClick={() => void remove(item)}
                      >
                        {deleting === item.path ? (
                          <Spinner size={14} />
                        ) : (
                          <Icon name="trash" size={16} />
                        )}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {others.length ? (
            <section className="asset-section">
              <h2 className="section-label">
                其他文件<span className="count">{others.length}</span>
              </h2>
              <div className="asset-file-list">
                {others.map((item) => (
                  <div className="asset-file" key={item.path}>
                    <span className={`asset-file-icon ${item.kind}`}>
                      <Icon name={item.kind === 'audio' ? 'play' : 'download'} size={18} />
                    </span>
                    <div className="asset-file-body">
                      <span className="asset-file-name" title={item.name}>{item.name}</span>
                      <span className="asset-file-meta">
                        {sizeText(item.size)}
                        {timeText(item.modified) ? ` · ${timeText(item.modified)}` : ''}
                      </span>
                    </div>
                    <a
                      className="icon-button tiny"
                      href={assetUrl(item.path, true)}
                      download={item.name}
                      title="下载"
                      aria-label="下载"
                    >
                      <Icon name="download" size={16} />
                    </a>
                    <button
                      type="button"
                      className="icon-button tiny danger"
                      title={zh.common.delete}
                      aria-label={zh.common.delete}
                      disabled={deleting === item.path}
                      onClick={() => void remove(item)}
                    >
                      {deleting === item.path ? (
                        <Spinner size={14} />
                      ) : (
                        <Icon name="trash" size={16} />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <Modal
        title={viewer?.name ?? '素材预览'}
        open={Boolean(viewer)}
        onClose={() => setViewer(null)}
        footer={
          viewer ? (
            <>
              <button
                type="button"
                className="button ghost danger"
                disabled={deleting === viewer.path}
                onClick={() => void remove(viewer)}
              >
                <Icon name="trash" size={18} />
                {zh.common.delete}
              </button>
              <a
                className="button secondary"
                href={assetUrl(viewer.path, true)}
                download={viewer.name}
              >
                <Icon name="download" size={18} />
                下载
              </a>
            </>
          ) : undefined
        }
      >
        {viewer ? (
          <div className="viewer">
            <img className="viewer-media" src={assetUrl(viewer.path)} alt={viewer.name} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
