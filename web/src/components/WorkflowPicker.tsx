import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { WorkflowSummary } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { zh } from '../i18n';
import { Icon, type IconName } from './Icon';
import { Spinner } from './UI';
import { readRecentWorkflows, rememberWorkflow } from '../recent';

type MediaKind = 'image' | 'video' | 'audio';

const MEDIA_ICON: Record<MediaKind, IconName> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

const MEDIA_KINDS: MediaKind[] = ['image', 'video', 'audio'];

function mediaKind(item: WorkflowSummary): MediaKind | null {
  return item.media === 'image' || item.media === 'video' || item.media === 'audio'
    ? item.media
    : null;
}

function formatBadge(item: WorkflowSummary): string {
  if (item.hasAppConfig) return zh.workflow.appMode;
  if (item.format === 'api') return zh.workflow.apiFormat;
  return zh.workflow.uiFormat;
}

interface WorkflowPickerProps {
  open: boolean;
  project: string;
  onClose: () => void;
  onSelect: (key: string) => void;
}

/**
 * Bottom sheet for choosing a workflow to run inside a project. Workflows are
 * not listed on the home screen any more; this picker is the only entry point.
 */
export function WorkflowPicker({ open, project, onClose, onSelect }: WorkflowPickerProps) {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mediaFilter, setMediaFilter] = useState<'all' | MediaKind>('all');
  const [recent, setRecent] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (refresh = false): Promise<void> => {
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
    if (!open) return;
    setQuery('');
    setMediaFilter('all');
    setRecent(readRecentWorkflows());
    void load(false);
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const openWorkflow = (key: string): void => {
    rememberWorkflow(key);
    onSelect(key);
  };

  const mediaCounts = useMemo(() => {
    const counts: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
    for (const item of items) {
      const kind = mediaKind(item);
      if (kind) counts[kind] += 1;
    }
    return counts;
  }, [items]);
  const availableKinds = MEDIA_KINDS.filter((kind) => mediaCounts[kind] > 0);

  const matches = useCallback(
    (item: WorkflowSummary): boolean => {
      const kind = mediaKind(item);
      if (mediaFilter !== 'all' && kind !== mediaFilter) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const haystack = [
        item.name,
        item.path,
        kind ? `${zh.workflow.media[kind]} ${kind}` : '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    },
    [mediaFilter, query],
  );

  const filtered = useMemo(() => items.filter(matches), [items, matches]);

  const recentItems = useMemo(
    () =>
      recent
        .map((key) => items.find((item) => item.key === key))
        .filter((item): item is WorkflowSummary => item !== undefined)
        .filter(matches),
    [items, matches, recent],
  );
  const showRecent = !query && mediaFilter === 'all' && recentItems.length > 0;

  const importFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const text = await file.text();
      const workflow = JSON.parse(text) as unknown;
      const name = file.name.replace(/\.json$/i, '');
      const result = await api.importWorkflow(name, workflow);
      await load(true);
      openWorkflow(result.item.key);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="picker-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="picker-sheet workflow-picker"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="picker-head">
          <strong>选择工作流</strong>
          <div className="header-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={zh.workflow.refresh}
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? <Spinner size={18} /> : <Icon name="refresh" size={20} />}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={zh.common.close}
              onClick={onClose}
            >
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>

        <div className="toolbar">
          <div className="search-field">
            <Icon name="search" size={18} />
            <input
              value={query}
              placeholder={zh.workflow.searchPlaceholder}
              aria-label={zh.workflow.searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="clear-button"
                aria-label={zh.common.close}
                onClick={() => setQuery('')}
              >
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
            {importing ? <Spinner size={18} /> : <Icon name="plus" />}
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

        {availableKinds.length > 1 ? (
          <div className="filter-chips media-filter" role="group" aria-label="按生成类型筛选">
            <button
              type="button"
              className={`filter-chip${mediaFilter === 'all' ? ' active' : ''}`}
              onClick={() => setMediaFilter('all')}
            >
              全部 <span className="chip-count">{items.length}</span>
            </button>
            {availableKinds.map((kind) => (
              <button
                type="button"
                key={kind}
                className={`filter-chip media-chip ${kind}${
                  mediaFilter === kind ? ' active' : ''
                }`}
                onClick={() => setMediaFilter(kind)}
              >
                <Icon name={MEDIA_ICON[kind]} size={13} />
                {zh.workflow.media[kind]}
                <span className="chip-count">{mediaCounts[kind]}</span>
              </button>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          className="template-entry"
          onClick={() =>
            navigate(`/templates?project=${encodeURIComponent(project)}`)
          }
        >
          <span className="template-entry-icon" aria-hidden="true">
            <Icon name="spark" size={20} />
          </span>
          <span className="template-entry-main">
            <span className="template-entry-title">官方模板库</span>
            <span className="template-entry-desc">从 ComfyUI 内置模板创建工作流</span>
          </span>
          <Icon name="chevron" size={18} className="chevron" />
        </button>

        {error ? (
          <div className="asset-picker-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
            <button type="button" className="text-button" onClick={() => void load(true)}>
              {zh.common.retry}
            </button>
          </div>
        ) : null}

        <div className="workflow-picker-body">
          {loading ? (
            <div className="loading-block">
              <Spinner size={26} label={zh.common.loading} />
            </div>
          ) : items.length === 0 && !error ? (
            <div className="asset-picker-empty">
              <Icon name="spark" size={26} />
              <p>{zh.workflow.empty}</p>
              <p>{zh.workflow.emptyHint}</p>
            </div>
          ) : (
            <>
              {showRecent ? (
                <section className="workflow-section">
                  <h2 className="section-label">{zh.workflow.recent}</h2>
                  <div className="workflow-list">
                    {recentItems.slice(0, 3).map((item) => (
                      <WorkflowCard
                        key={`recent-${item.key}`}
                        item={item}
                        onOpen={openWorkflow}
                      />
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
                  <p className="picker-empty">没有匹配的工作流</p>
                ) : (
                  <div className="workflow-list">
                    {filtered.map((item) => (
                      <WorkflowCard key={item.key} item={item} onOpen={openWorkflow} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function WorkflowCard({
  item,
  onOpen,
}: {
  item: WorkflowSummary;
  onOpen: (key: string) => void;
}) {
  const kind = mediaKind(item);
  return (
    <button
      type="button"
      className={`workflow-card${kind ? ` media-${kind}` : ''}`}
      onClick={() => onOpen(item.key)}
    >
      <span className="workflow-thumb" aria-hidden="true">
        <Icon name={kind ? MEDIA_ICON[kind] : item.hasAppConfig ? 'spark' : 'grid'} size={22} />
      </span>
      <span className="workflow-main">
        <span className="workflow-name-row">
          <span className="workflow-name">{item.name}</span>
          {kind ? (
            <span className={`media-badge ${kind}`}>
              <Icon name={MEDIA_ICON[kind]} size={11} />
              {zh.workflow.media[kind]}
            </span>
          ) : null}
        </span>
        <span className="workflow-meta">
          <span className={`format-badge ${item.hasAppConfig ? 'app' : item.format ?? 'ui'}`}>
            {formatBadge(item)}
          </span>
          {item.source === 'imported' ? (
            <span className="source-tag">{zh.workflow.imported}</span>
          ) : null}
          {item.path !== item.name ? (
            <span className="workflow-path">{item.path}</span>
          ) : null}
        </span>
      </span>
      <Icon name="chevron" size={18} className="chevron" />
    </button>
  );
}
