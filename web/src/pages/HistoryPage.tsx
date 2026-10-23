import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RunSummary } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
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
  const [items, setItems] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const response = await api.listRuns(100);
      setItems(response.items);
      setError(null);
    } catch (cause) {
      if (!silent) setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

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
        subtitle={items.length ? `${items.length} 次运行` : undefined}
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label={zh.common.refresh}
            disabled={refreshing}
            onClick={() => void load()}
          >
            {refreshing ? <Spinner size={20} /> : <Icon name="refresh" />}
          </button>
        }
      />

      {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}

      {loading ? (
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      ) : items.length === 0 && !error ? (
        <EmptyState
          icon="history"
          title={zh.history.empty}
          hint={zh.history.emptyHint}
          action={
            <button type="button" className="button secondary" onClick={() => navigate('/')}>
              选择工作流
            </button>
          }
        />
      ) : (
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
          ))}
        </div>
      )}
    </div>
  );
}
