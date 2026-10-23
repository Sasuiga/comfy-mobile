import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AssetDirEntry, AssetEntry } from '@comfy-mobile/shared';
import { api, assetUrl, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon } from './Icon';
import { Spinner } from './UI';

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

function kindIcon(kind: AssetEntry['kind']): 'image' | 'video' | 'play' | 'download' {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'play';
  return 'download';
}

export interface AssetPickerProps {
  open: boolean;
  title?: string;
  kinds?: AssetEntry['kind'][];
  /** Restrict browsing to a project's inputs/ and outputs/ folders. */
  project?: string;
  onClose: () => void;
  onSelect: (entry: AssetEntry) => void;
}

export function AssetPicker({
  open,
  title = '选择素材',
  kinds = ['image'],
  project,
  onClose,
  onSelect,
}: AssetPickerProps) {
  const { showToast } = useApp();
  const inputRoot = project ? `${project}/inputs` : 'inputs';
  const outputRoot = project ? `${project}/outputs` : 'outputs';
  const [root, setRoot] = useState<AssetRoot>('inputs');
  const [dir, setDir] = useState(inputRoot);
  const [dirs, setDirs] = useState<AssetDirEntry[]>([]);
  const [files, setFiles] = useState<AssetEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path: string) => {
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
    if (!open) return;
    setRoot('inputs');
    setDir(inputRoot);
    setQuery('');
    void load(inputRoot);
  }, [open, inputRoot, load]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const rootPath = root === 'inputs' ? inputRoot : outputRoot;

  const switchRoot = (next: AssetRoot): void => {
    setRoot(next);
    const nextPath = next === 'inputs' ? inputRoot : outputRoot;
    setDir(nextPath);
    setQuery('');
    void load(nextPath);
  };

  const enterDir = (path: string): void => {
    setDir(path);
    void load(path);
  };

  const goUp = (): void => {
    if (dir === rootPath) return;
    const index = dir.lastIndexOf('/');
    const next = index >= 0 ? dir.slice(0, index) : rootPath;
    enterDir(next === rootPath || next.startsWith(`${rootPath}/`) ? next : rootPath);
  };

  const upload = async (list: FileList | null): Promise<void> => {
    const selected = Array.from(list ?? []);
    if (!selected.length) return;
    setUploading(true);
    let last: AssetEntry | undefined;
    try {
      for (const file of selected) {
        const response = await api.uploadAsset(file, dir);
        last = response.item;
      }
      await load(dir);
      showToast(
        selected.length > 1 ? `已上传 ${selected.length} 个素材` : `已上传 ${last?.name ?? '素材'}`,
        'success',
      );
      if (last) onSelect(last);
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const visibleDirs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? dirs.filter((dir) => dir.name.toLowerCase().includes(q)) : dirs;
  }, [dirs, query]);

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter(
      (file) =>
        kinds.includes(file.kind) && (!q || file.name.toLowerCase().includes(q)),
    );
  }, [files, kinds, query]);

  if (!open) return null;

  const accept = kinds.includes('image')
    ? kinds.includes('video') || kinds.includes('audio')
      ? 'image/*,video/*,audio/*'
      : 'image/*'
    : 'video/*,audio/*';

  return createPortal(
    <div className="picker-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="picker-sheet asset-picker" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>{title}</strong>
          <button type="button" className="icon-button" aria-label={zh.common.close} onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="segment-row asset-picker-tabs">
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

        <div className="asset-picker-toolbar">
          <div className="search-field">
            <Icon name="search" size={16} />
            <input
              value={query}
              placeholder="搜索素材"
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
          <button
            type="button"
            className="icon-button bordered"
            title="上传素材"
            aria-label="上传素材"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Spinner size={18} /> : <Icon name="upload" size={20} />}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            multiple
            hidden
            onChange={(event) => void upload(event.target.files)}
          />
        </div>

        <div className="asset-picker-path">
          <button
            type="button"
            className="icon-button tiny"
            aria-label="上一级"
            disabled={dir === rootPath}
            onClick={goUp}
          >
            <Icon name="back" size={16} />
          </button>
          <span title={dir}>
            {dir === rootPath
              ? ROOT_LABELS[root]
              : dir.slice(rootPath.length + 1)}
          </span>
        </div>

        {error ? (
          <div className="asset-picker-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
            <button type="button" className="text-button" onClick={() => void load(dir)}>
              {zh.common.retry}
            </button>
          </div>
        ) : null}

        <div className="asset-picker-body">
          {loading ? (
            <div className="loading-block"><Spinner size={24} label={zh.common.loading} /></div>
          ) : (
            <>
              {visibleDirs.length ? (
                <div className="asset-dir-list">
                  {visibleDirs.map((item) => (
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
              ) : null}

              {visibleFiles.length ? (
                <div className="asset-picker-grid">
                  {visibleFiles.map((item) => (
                    <button
                      type="button"
                      key={item.path}
                      className="asset-tile"
                      onClick={() => onSelect(item)}
                    >
                      <span className="asset-tile-media">
                        {item.kind === 'image' ? (
                          <img src={assetUrl(item.path)} alt="" loading="lazy" />
                        ) : (
                          <Icon name={kindIcon(item.kind)} size={26} />
                        )}
                      </span>
                      <span className="asset-tile-name" title={item.name}>{item.name}</span>
                      <span className="asset-tile-meta">
                        {item.kind.toUpperCase()} · {sizeText(item.size)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : !visibleDirs.length ? (
                <div className="asset-picker-empty">
                  <Icon name="image" size={26} />
                  <p>{query ? '没有匹配的素材' : '这里还没有素材，点右上角上传。'}</p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
