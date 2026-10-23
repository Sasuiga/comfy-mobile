import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AssetDirEntry, AssetStorageInfo } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon } from './Icon';
import { Spinner } from './UI';

interface WorkspacePickerProps {
  open: boolean;
  info: AssetStorageInfo;
  onClose: () => void;
  onSelected: (info: AssetStorageInfo) => void;
}

/**
 * Lets the user pick (or create) the project root directory under the
 * configured browse root. Each subfolder inside it becomes a project.
 */
export function WorkspacePicker({ open, info, onClose, onSelected }: WorkspacePickerProps) {
  const { showToast } = useApp();
  const [path, setPath] = useState('');
  const [dirs, setDirs] = useState<AssetDirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (target: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.browseAssetDirs(target);
      setDirs(response.dirs);
    } catch (cause) {
      setError(errorMessage(cause));
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const start = info.workspace.includes('/')
      ? info.workspace.slice(0, info.workspace.lastIndexOf('/'))
      : '';
    setPath(start);
    setNewName('');
    void load(start);
  }, [open, info.workspace, load]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const enter = (target: string): void => {
    setPath(target);
    setNewName('');
    void load(target);
  };

  const goUp = (): void => {
    const index = path.lastIndexOf('/');
    enter(index >= 0 ? path.slice(0, index) : '');
  };

  const select = async (target: string): Promise<void> => {
    if (!target) {
      showToast('请先进入或新建一个文件夹', 'error');
      return;
    }
    setSaving(true);
    try {
      const next = await api.selectAssetWorkspace(target);
      onSelected(next);
      showToast(`项目根目录已切换到 ${next.workspace}`, 'success');
      onClose();
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setSaving(false);
    }
  };

  const create = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) return;
    if (/[\\/]/.test(name) || name === '.' || name === '..' || /[\u0000-\u001f]/.test(name)) {
      showToast('文件夹名称不合法', 'error');
      return;
    }
    await select(path ? `${path}/${name}` : name);
  };

  if (!open) return null;

  return createPortal(
    <div className="picker-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="picker-sheet workspace-picker" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>选择项目根目录</strong>
          <button type="button" className="icon-button" aria-label={zh.common.close} onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>

        <p className="workspace-picker-hint">
          每个项目会是这个根目录下的一个文件夹，包含自己的 inputs/ 与 outputs/。
          根目录：{info.browseRoot}
        </p>

        <div className="asset-picker-path">
          <button
            type="button"
            className="icon-button tiny"
            aria-label="上一级"
            disabled={!path || loading}
            onClick={goUp}
          >
            <Icon name="back" size={16} />
          </button>
          <span title={path || '/'}>{path || '可选根目录'}</span>
        </div>

        {error ? (
          <div className="asset-picker-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
            <button type="button" className="text-button" onClick={() => void load(path)}>
              {zh.common.retry}
            </button>
          </div>
        ) : null}

        <div className="asset-picker-body">
          {loading ? (
            <div className="loading-block"><Spinner size={24} label={zh.common.loading} /></div>
          ) : dirs.length ? (
            <div className="asset-dir-list">
              {dirs.map((item) => (
                <button
                  type="button"
                  key={item.path}
                  className={`asset-dir${item.path === info.workspace ? ' current' : ''}`}
                  onClick={() => enter(item.path)}
                >
                  <Icon name="folder" size={18} />
                  <span>{item.name}</span>
                  {item.path === info.workspace ? <small>当前</small> : null}
                  <Icon name="chevron" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <p className="picker-empty">这个位置还没有子文件夹，可以在下方新建。</p>
          )}
        </div>

        <div className="workspace-picker-footer">
          <div className="inline-row">
            <input
              className="input"
              value={newName}
              maxLength={80}
              placeholder="新建文件夹名称"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create();
              }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={saving || !newName.trim()}
              onClick={() => void create()}
            >
              新建
            </button>
          </div>
          <button
            type="button"
            className="button primary block"
            disabled={saving || !path}
            onClick={() => void select(path)}
          >
            {saving ? <Spinner size={18} label="正在切换…" /> : '使用当前目录'}
          </button>
          <p className="field-desc">
            切换后，新建项目会落在新根目录；已有项目不会移动，切回原目录即可继续访问。
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
