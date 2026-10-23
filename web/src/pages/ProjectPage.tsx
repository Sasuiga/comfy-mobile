import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProjectSummary, RunSummary } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  StatusBadge,
  usePageTitle,
} from '../components/UI';
import { zh } from '../i18n';
import { AssetsPage } from './AssetsPage';

type Tab = 'inputs' | 'outputs' | 'runs';
const ACTIVE = new Set(['queued', 'running']);

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ProjectPage() {
  const { project = '' } = useParams<{ project: string }>();
  const navigate = useNavigate();
  const { showToast } = useApp();
  const [item, setItem] = useState<ProjectSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('inputs');
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await api.getProject(project);
      setItem(response.item);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setLoading(true);
    setItem(null);
    setTab('inputs');
    void load();
  }, [load]);

  usePageTitle(item?.name ?? '项目');

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshKey((value) => value + 1);
    setRefreshing(false);
  };

  const remove = async (): Promise<void> => {
    if (!item || item.isDefault) return;
    if (
      !window.confirm(
        `直接删除项目「${item.title}」？\n项目文件夹（${item.name}）及其中所有素材、输出都会被永久删除，无法恢复。\n（运行历史会保留）`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteProject(item.path);
      showToast('项目已删除', 'success');
      navigate('/');
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
      setDeleting(false);
    }
  };

  if (loading && !item) {
    return (
      <div className="page">
        <PageHeader title="项目" back="/" />
        <div className="loading-block">
          <Spinner size={28} label={zh.common.loading} />
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="page">
        <PageHeader title="项目" back="/" />
        <ErrorBox
          message={error ?? '项目不存在或已被删除'}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
      </div>
    );
  }

  const generateHref = `/generate?project=${encodeURIComponent(item.path)}`;

  return (
    <div className="page project-page">
      <PageHeader
        title={item.title}
        back="/"
        subtitle={
          <span className="header-chips">
            {item.isDefault ? <span className="default-badge">默认</span> : null}
            {item.createdDate ? <span>{item.createdDate}</span> : null}
            <span>素材 {item.inputCount}</span>
            <span>输出 {item.outputCount}</span>
          </span>
        }
        actions={
          <>
            <button
              type="button"
              className="icon-button"
              aria-label={zh.common.refresh}
              title={zh.common.refresh}
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {refreshing ? <Spinner size={18} /> : <Icon name="refresh" />}
            </button>
            {item.isDefault ? null : (
              <button
                type="button"
                className="icon-button danger"
                aria-label="删除项目"
                title="删除项目"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {deleting ? <Spinner size={18} /> : <Icon name="trash" />}
              </button>
            )}
          </>
        }
      />

      <div className="segment-row project-tabs">
        <button
          type="button"
          className={`segment${tab === 'inputs' ? ' active' : ''}`}
          onClick={() => setTab('inputs')}
        >
          素材<span className="count">{item.inputCount}</span>
        </button>
        <button
          type="button"
          className={`segment${tab === 'outputs' ? ' active' : ''}`}
          onClick={() => setTab('outputs')}
        >
          输出<span className="count">{item.outputCount}</span>
        </button>
        <button
          type="button"
          className={`segment${tab === 'runs' ? ' active' : ''}`}
          onClick={() => setTab('runs')}
        >
          记录
        </button>
      </div>

      {tab === 'inputs' ? (
        <AssetsPage
          key={`inputs-${refreshKey}`}
          project={item.path}
          section="inputs"
          embedded
          onChanged={() => void load()}
        />
      ) : tab === 'outputs' ? (
        <AssetsPage
          key={`outputs-${refreshKey}`}
          project={item.path}
          section="outputs"
          embedded
          allowUpload={false}
          onChanged={() => void load()}
        />
      ) : (
        <ProjectRuns key={`runs-${refreshKey}`} project={item.path} />
      )}

      <Link className="project-fab" to={generateHref}>
        <Icon name="play" size={18} />
        生成
      </Link>
    </div>
  );
}

function ProjectRuns({ project }: { project: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false): Promise<void> => {
      try {
        const response = await api.listRuns(50, project);
        setItems(response.items);
        setError(null);
      } catch (cause) {
        if (!silent) setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [project],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const hasActive = items.some((item) => ACTIVE.has(item.state));

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setTimeout(() => void load(true), 4000);
    return () => window.clearTimeout(timer);
  }, [hasActive, items, load]);

  if (loading) {
    return (
      <div className="loading-block">
        <Spinner size={26} label={zh.common.loading} />
      </div>
    );
  }

  if (error) {
    return <ErrorBox message={error} onRetry={() => void load()} />;
  }

  if (!items.length) {
    return (
      <EmptyState
        icon="history"
        title="这个项目还没有运行记录"
        hint="点击右下角「生成」，选择工作流开始创作。"
      />
    );
  }

  return (
    <div className="run-list">
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          className="run-card"
          onClick={() => navigate(`/runs/${item.id}`)}
        >
          <span className="run-thumb">
            {item.thumbnail ? (
              <img src={item.thumbnail} alt="" loading="lazy" />
            ) : (
              <Icon name={item.state === 'failed' ? 'alert' : 'image'} size={24} />
            )}
          </span>
          <span className="run-card-main">
            <span className="run-card-top">
              <strong>{item.workflowName}</strong>
              <StatusBadge state={item.state} />
            </span>
            <span className="run-card-meta">
              <span>{formatWhen(item.createdAt)}</span>
              {item.outputCount > 0 ? (
                <span>
                  {item.outputCount} {zh.history.resultCount}
                </span>
              ) : null}
              {ACTIVE.has(item.state) ? <span className="live-dot">进行中</span> : null}
            </span>
            {item.errorMessage ? (
              <span className="run-error">{item.errorMessage}</span>
            ) : null}
          </span>
          <Icon name="chevron" size={18} className="chevron" />
        </button>
      ))}
    </div>
  );
}
