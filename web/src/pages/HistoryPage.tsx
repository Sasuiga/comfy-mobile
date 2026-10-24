import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_PROJECT,
  projectDisplayTitle,
  type ProjectSummary,
  type RunSummary,
} from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { Icon } from '../components/Icon';
import { SwipeRow } from '../components/SwipeRow';
import { useApp } from '../context';
import {
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  StatusBadge,
  usePageTitle,
} from '../components/UI';
import { zh } from '../i18n';

const ACTIVE = new Set(['queued', 'running']);

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();
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

export function HistoryPage() {
  usePageTitle(zh.history.title);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = params.get('project') ?? '';
  const [items, setItems] = useState<RunSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useApp();

  const loadProjects = useCallback(async (): Promise<void> => {
    try {
      const response = await api.listProjects();
      setProjects(response.items);
    } catch {
      // The project chips are an optional filter; ignore failures.
    }
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const response = await api.listRuns(100, filter || undefined);
        setItems(response.items);
        setError(null);
      } catch (cause) {
        if (!silent) setError(errorMessage(cause));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filter],
  );

  useEffect(() => {
    setLoading(true);
    void load(true);
  }, [load]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const setFilter = (path: string): void => {
    setOpenId(null);
    const next = new URLSearchParams(params);
    if (path) next.set('project', path);
    else next.delete('project');
    setParams(next, { replace: true });
  };

  const refresh = (): void => {
    void loadProjects();
    void load();
  };

  const clear = async (): Promise<void> => {
    const scope = filter ? `「${projectDisplayTitle(filter)}」的` : '全部';
    const confirmed = window.confirm(
      `清空${scope}运行历史？\n只删除历史记录，已保存的结果文件会保留；进行中的任务不会被删除。`,
    );
    if (!confirmed) return;
    setClearing(true);
    try {
      const result = await api.clearRuns(filter || undefined);
      if (result.removed) {
        showToast(
          result.kept
            ? `已清理 ${result.removed} 条历史记录，${result.kept} 次进行中的任务已保留`
            : `已清理 ${result.removed} 条历史记录`,
          'success',
        );
      } else {
        showToast('没有可清理的历史记录，进行中的任务会保留', 'info');
      }
      setItems([]);
      await load(false);
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setClearing(false);
    }
  };

  const remove = async (item: RunSummary): Promise<void> => {
    setOpenId(null);
    if (ACTIVE.has(item.state)) {
      showToast('进行中的任务不能删除，请先取消或等待完成', 'info');
      return;
    }
    if (
      !window.confirm(
        `删除「${item.workflowName}」的这条历史记录？\n已保存的结果文件会保留。`,
      )
    ) {
      return;
    }
    setRemovingId(item.id);
    try {
      await api.deleteRun(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      showToast('已删除这条历史记录', 'success');
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setRemovingId(null);
    }
  };

  const hasActive = useMemo(() => items.some((item) => ACTIVE.has(item.state)), [items]);

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setTimeout(() => {
      void load(true);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [hasActive, items, load]);

  return (
    <div className="page">
      <PageHeader
        large
        title={zh.history.title}
        subtitle={
          items.length
            ? `${items.length} 次运行${filter ? ` · ${filter}` : ''}`
            : undefined
        }
        actions={
          <>
            {items.length ? (
              <button
                type="button"
                className="icon-button danger"
                aria-label={zh.history.clear}
                title={zh.history.clear}
                disabled={clearing || refreshing}
                onClick={() => void clear()}
              >
                {clearing ? <Spinner size={20} /> : <Icon name="trash" />}
              </button>
            ) : null}
            <button
              type="button"
              className="icon-button"
              aria-label={zh.common.refresh}
              disabled={refreshing || clearing}
              onClick={refresh}
            >
              {refreshing ? <Spinner size={20} /> : <Icon name="refresh" />}
            </button>
          </>
        }
      />

      {projects.length ? (
        <div className="filter-chips">
          <button
            type="button"
            className={`filter-chip${filter ? '' : ' active'}`}
            onClick={() => setFilter('')}
          >
            全部
          </button>
          {projects.map((project) => (
            <button
              type="button"
              key={project.path}
              className={`filter-chip${filter === project.path ? ' active' : ''}`}
              onClick={() => setFilter(project.path)}
            >
              {project.title}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}

      {loading ? (
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      ) : items.length === 0 && !error ? (
        <EmptyState
          icon="history"
          title={filter ? '这个项目还没有运行记录' : zh.history.empty}
          hint={zh.history.emptyHint}
          action={
            filter ? (
              <button type="button" className="button secondary" onClick={() => setFilter('')}>
                查看全部历史
              </button>
            ) : (
              <button type="button" className="button secondary" onClick={() => navigate('/')}>
                选择项目
              </button>
            )
          }
        />
      ) : (
        <div className="run-list">
          {items.map((item) => {
            const open = openId === item.id;
            return (
              <SwipeRow
                key={item.id}
                open={open}
                onOpenChange={(next) => setOpenId(next ? item.id : null)}
                action={
                  <button
                    type="button"
                    className="swipe-delete"
                    aria-label={`删除「${item.workflowName}」的历史记录`}
                    aria-hidden={!open}
                    tabIndex={open ? 0 : -1}
                    disabled={removingId === item.id}
                    onClick={() => void remove(item)}
                  >
                    {removingId === item.id ? (
                      <Spinner size={18} />
                    ) : (
                      <Icon name="trash" size={20} />
                    )}
                    <span>{zh.common.delete}</span>
                  </button>
                }
              >
                <button
                  type="button"
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
                      {item.project ? (
                        <span className="run-project">
                          {projectDisplayTitle(item.project ?? DEFAULT_PROJECT)}
                        </span>
                      ) : null}
                      <span>{formatWhen(item.createdAt)}</span>
                      {item.outputCount > 0 ? (
                        <span>{item.outputCount} {zh.history.resultCount}</span>
                      ) : null}
                      {ACTIVE.has(item.state) ? <span className="live-dot">进行中</span> : null}
                    </span>
                    {item.errorMessage ? (
                      <span className="run-error">{item.errorMessage}</span>
                    ) : null}
                  </span>
                  <Icon name="chevron" size={18} className="chevron" />
                </button>
              </SwipeRow>
            );
          })}
        </div>
      )}
    </div>
  );
}
