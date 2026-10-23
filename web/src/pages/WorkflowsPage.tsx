import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkflowSummary } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  usePageTitle,
} from '../components/UI';

const RECENT_KEY = 'comfy-mobile.recent-workflows';

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberWorkflow(key: string): void {
  try {
    const next = [key, ...readRecent().filter((item) => item !== key)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

function formatBadge(item: WorkflowSummary): string {
  if (item.hasAppConfig) return zh.workflow.appMode;
  if (item.format === 'api') return zh.workflow.apiFormat;
  return zh.workflow.uiFormat;
}

export function WorkflowsPage() {
  usePageTitle(zh.workflow.title);
  const navigate = useNavigate();
  const { config } = useApp();
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      const response = await api.listWorkflows(refresh);
      setItems(response.items);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const open = (key: string): void => {
    rememberWorkflow(key);
    setRecent(readRecent());
    navigate(`/w/${encodeURIComponent(key)}`);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.path.toLowerCase().includes(q),
        )
      : items;
    return list;
  }, [items, query]);

  const recentItems = useMemo(
    () =>
      recent
        .map((key) => items.find((item) => item.key === key))
        .filter((item): item is WorkflowSummary => Boolean(item)),
    [items, recent],
  );
  const showRecent = !query && recentItems.length > 0;

  const importFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const text = await file.text();
      const workflow = JSON.parse(text) as unknown;
      const name = file.name.replace(/\.json$/i, '');
      const result = await api.importWorkflow(name, workflow);
      await load(true);
      open(result.item.key);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="page">
      <PageHeader
        large
        title={zh.workflow.title}
        subtitle={
          config ? (
            <span className={`connection-line${config.connected ? ' ok' : ' bad'}`}>
              <span className="status-dot" />
              {config.connected ? zh.status.connected : zh.status.disconnected}
              {config.comfyVersion ? ` · ComfyUI ${config.comfyVersion}` : ''}
            </span>
          ) : undefined
        }
        actions={
          <>
            <button
              type="button"
              className="icon-button"
              aria-label={zh.workflow.refresh}
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? <Spinner size={20} /> : <Icon name="refresh" />}
            </button>
          </>
        }
      />

      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" size={18} />
          <input
            value={query}
            placeholder={zh.workflow.searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={zh.workflow.searchPlaceholder}
          />
          {query ? (
            <button type="button" className="clear-button" onClick={() => setQuery('')} aria-label={zh.common.close}>
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="icon-button bordered"
          title="导入 API 工作流"
          aria-label="导入 API 工作流"
          disabled={importing}
          onClick={() => fileRef.current?.click()}
        >
          {importing ? <Spinner size={20} /> : <Icon name="plus" />}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </div>

      {error ? (
        <ErrorBox message={error} onRetry={() => void load(true)} />
      ) : null}

      {loading ? (
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      ) : items.length === 0 && !error ? (
        <EmptyState
          title={zh.workflow.empty}
          hint={zh.workflow.emptyHint}
          action={
            <button type="button" className="button secondary" onClick={() => navigate('/settings')}>
              {zh.settings.title}
            </button>
          }
        />
      ) : (
        <>
          {showRecent ? (
            <section className="workflow-section">
              <h2 className="section-label">{zh.workflow.recent}</h2>
              <div className="workflow-list">
                {recentItems.slice(0, 3).map((item) => (
                  <WorkflowCard key={`recent-${item.key}`} item={item} onOpen={open} />
                ))}
              </div>
            </section>
          ) : null}

          <section className="workflow-section">
            <h2 className="section-label">
              {zh.workflow.all}
              <span className="count">{filtered.length}</span>
            </h2>
            {filtered.length === 0 ? (
              <EmptyState title="没有匹配的工作流" hint="换个关键词试试。" />
            ) : (
              <div className="workflow-list">
                {filtered.map((item) => (
                  <WorkflowCard key={item.key} item={item} onOpen={open} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function WorkflowCard({
  item,
  onOpen,
}: {
  item: WorkflowSummary;
  onOpen: (key: string) => void;
}) {
  return (
    <button type="button" className="workflow-card" onClick={() => onOpen(item.key)}>
      <span className="workflow-thumb" aria-hidden="true">
        <Icon name={item.hasAppConfig ? 'spark' : 'grid'} size={22} />
      </span>
      <span className="workflow-main">
        <span className="workflow-name">{item.name}</span>
        <span className="workflow-meta">
          <span className={`format-badge ${item.hasAppConfig ? 'app' : item.format ?? 'ui'}`}>
            {formatBadge(item)}
          </span>
          {item.source === 'imported' ? <span className="source-tag">{zh.workflow.imported}</span> : null}
          {item.path !== item.name ? <span className="workflow-path">{item.path}</span> : null}
        </span>
      </span>
      <Icon name="chevron" size={18} className="chevron" />
    </button>
  );
}
