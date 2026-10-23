import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  projectDateStamp,
  type ProjectListResponse,
  type ProjectSummary,
} from '@comfy-mobile/shared';
import { api, assetUrl, errorMessage } from '../api';
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

function updatedText(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '暂无内容';
  const date = new Date(timestamp);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return sameYear ? `${month}-${day} ${hour}:${minute}` : `${date.getFullYear()}-${month}-${day}`;
}

export function ProjectsPage() {
  usePageTitle(zh.nav.projects);
  const navigate = useNavigate();
  const { showToast } = useApp();
  const [data, setData] = useState<ProjectListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async (refresh = false): Promise<void> => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      setData(await api.listProjects());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const items = useMemo(() => data?.items ?? [], [data]);

  const openCreate = (): void => {
    setName('');
    setCreateError(null);
    setCreateOpen(true);
  };

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError('请输入项目名称');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const { item } = await api.createProject(trimmed);
      setCreateOpen(false);
      showToast(`已创建「${item.title}」`, 'success');
      navigate(`/p/${encodeURIComponent(item.path)}`);
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (project: ProjectSummary): Promise<void> => {
    if (project.isDefault) return;
    if (
      !window.confirm(
        `直接删除项目「${project.title}」？\n项目文件夹（${project.name}）及其中所有素材、输出都会被永久删除，无法恢复。\n（运行历史会保留）`,
      )
    ) {
      return;
    }
    setDeleting(project.path);
    try {
      await api.deleteProject(project.path);
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.filter((item) => item.path !== project.path),
            }
          : current,
      );
      showToast('项目已删除', 'success');
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="page projects-page">
      <PageHeader
        large
        title="项目"
        subtitle={
          data ? (
            <span className="assets-storage-line" title={data.root}>
              <Icon name="folder" size={14} />
              {data.root}
            </span>
          ) : undefined
        }
        actions={
          <>
            <button
              type="button"
              className="icon-button bordered"
              aria-label="新建项目"
              title="新建项目"
              onClick={openCreate}
            >
              <Icon name="plus" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={zh.common.refresh}
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? <Spinner size={18} /> : <Icon name="refresh" />}
            </button>
          </>
        }
      />

      {data?.fallback ? (
        <div className="asset-warning" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>项目根目录暂不可用</strong>
            <p>{data.warning ?? '正在使用服务数据目录保存项目。'}</p>
          </div>
        </div>
      ) : null}

      {error ? <ErrorBox message={error} onRetry={() => void load(true)} /> : null}

      {loading ? (
        <div className="loading-block">
          <Spinner size={28} label={zh.common.loading} />
        </div>
      ) : items.length === 0 && !error ? (
        <EmptyState
          icon="folder"
          title="还没有项目"
          hint="新建一个项目，把同一主题的素材、生成结果和运行记录放在一起。"
          action={
            <button type="button" className="button primary" onClick={openCreate}>
              <Icon name="plus" size={18} />
              新建项目
            </button>
          }
        />
      ) : (
        <div className="project-list">
          {items.map((project) => (
            <article className="project-card" key={project.path}>
              <button
                type="button"
                className="project-card-main"
                onClick={() => navigate(`/p/${encodeURIComponent(project.path)}`)}
              >
                <span className={`project-cover${project.cover ? ' has-cover' : ''}`}>
                  {project.cover ? (
                    <img src={assetUrl(project.cover)} alt="" loading="lazy" />
                  ) : (
                    <Icon name="folder" size={28} />
                  )}
                </span>
                <span className="project-info">
                  <span className="project-name-row">
                    <span className="project-name">{project.title}</span>
                    {project.isDefault ? <span className="default-badge">默认</span> : null}
                  </span>
                  <span className="project-meta">
                    {project.createdDate ? `${project.createdDate} · ` : ''}
                    素材 {project.inputCount} · 输出 {project.outputCount}
                  </span>
                  <span className="project-updated">
                    {project.outputCount || project.inputCount
                      ? `更新于 ${updatedText(project.updatedAt)}`
                      : '还没有素材'}
                  </span>
                </span>
                <Icon name="chevron" size={18} className="chevron" />
              </button>
              {project.isDefault ? null : (
                <button
                  type="button"
                  className="project-delete icon-button tiny danger"
                  title="删除项目"
                  aria-label={`删除项目 ${project.title}`}
                  disabled={deleting === project.path}
                  onClick={() => void remove(project)}
                >
                  {deleting === project.path ? (
                    <Spinner size={14} />
                  ) : (
                    <Icon name="trash" size={15} />
                  )}
                </button>
              )}
            </article>
          ))}
        </div>
      )}

      <Modal
        title="新建项目"
        open={createOpen}
        onClose={() => {
          if (!creating) setCreateOpen(false);
        }}
        footer={
          <>
            <button
              type="button"
              className="button ghost"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              {zh.common.cancel}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={creating || !name.trim()}
              onClick={() => void create()}
            >
              {creating ? <Spinner size={18} /> : '创建'}
            </button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">项目名称</span>
          <input
            className="input"
            autoFocus
            maxLength={71}
            value={name}
            placeholder="例如：秋季海报"
            onChange={(event) => {
              setName(event.target.value);
              setCreateError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create();
            }}
          />
        </label>
        {createError ? <p className="field-error">{createError}</p> : null}
        <p className="field-desc">
          会创建文件夹「YYYYMMDD-项目名称」（如 {projectDateStamp()}-秋季海报），内含
          inputs/ 与 outputs/。
        </p>
      </Modal>
    </div>
  );
}
