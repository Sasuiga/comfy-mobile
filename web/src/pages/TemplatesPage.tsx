import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { projectDisplayTitle, type WorkflowTemplate } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorBox,
  PageHeader,
  Spinner,
  usePageTitle,
} from '../components/UI';
import { rememberWorkflow } from '../recent';

type Mode = 'local' | 'all';

export function TemplatesPage() {
  usePageTitle('模板库');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const project = params.get('project')?.trim() ?? '';
  const projectQuery = project ? `?project=${encodeURIComponent(project)}` : '';
  const { showToast } = useApp();
  const [items, setItems] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('local');
  const [selected, setSelected] = useState<WorkflowTemplate | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    setError(null);
    try {
      const response = await api.listTemplates(refresh);
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

  const localCount = useMemo(
    () => items.filter((item) => !item.requiresApi).length,
    [items],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (mode === 'local' && item.requiresApi) return false;
      if (!q) return true;
      return [item.title, item.name, item.description ?? '', item.category, ...item.tags, ...item.models]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [items, mode, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, WorkflowTemplate[]>();
    for (const item of filtered) {
      const list = map.get(item.category);
      if (list) list.push(item);
      else map.set(item.category, [item]);
    }
    return [...map.entries()];
  }, [filtered]);

  const useTemplate = async (template: WorkflowTemplate): Promise<void> => {
    setImporting(template.name);
    try {
      const { item } = await api.importTemplate(template.name);
      rememberWorkflow(item.key);
      showToast(`已创建「${template.title}」`, 'success');
      navigate(`/w/${encodeURIComponent(item.key)}${projectQuery}`);
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
      setImporting(null);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="模板库"
        back={project ? `/generate${projectQuery}` : '/'}
        subtitle={
          <span className="template-subtitle">
            来自 ComfyUI 自带的官方工作流模板
            {project ? ` · ${projectDisplayTitle(project)}` : ''}
          </span>
        }
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label="刷新模板"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            {refreshing ? <Spinner size={20} /> : <Icon name="refresh" />}
          </button>
        }
      />

      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" size={18} />
          <input
            value={query}
            placeholder="搜索模板、模型或分类"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索模板"
          />
          {query ? (
            <button
              type="button"
              className="clear-button"
              onClick={() => setQuery('')}
              aria-label="清除"
            >
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="segment-row">
        <button
          type="button"
          className={`segment${mode === 'local' ? ' active' : ''}`}
          onClick={() => setMode('local')}
        >
          本地模型 <span>{localCount}</span>
        </button>
        <button
          type="button"
          className={`segment${mode === 'all' ? ' active' : ''}`}
          onClick={() => setMode('all')}
        >
          全部 <span>{items.length}</span>
        </button>
      </div>

      {error ? <ErrorBox message={error} onRetry={() => void load(true)} /> : null}

      {loading ? (
        <div className="loading-block">
          <Spinner size={28} label="加载模板中…" />
        </div>
      ) : filtered.length === 0 && !error ? (
        <EmptyState
          title="没有匹配的模板"
          hint={
            mode === 'local'
              ? '本地没有匹配项，可以切到「全部」看看需要 API 的模板。'
              : '换个关键词试试。'
          }
        />
      ) : (
        grouped.map(([category, list]) => (
          <section className="workflow-section" key={category}>
            <h2 className="section-label">
              {category}
              <span className="count">{list.length}</span>
            </h2>
            <div className="template-list">
              {list.map((template) => (
                <button
                  type="button"
                  className="template-card"
                  key={template.name}
                  onClick={() => setSelected(template)}
                >
                  <span className="template-card-head">
                    <span className="template-title">{template.title}</span>
                    {template.requiresApi ? (
                      <span className="template-badge api">API</span>
                    ) : null}
                  </span>
                  {template.description ? (
                    <span className="template-desc">{template.description}</span>
                  ) : null}
                  {template.models.length || template.mediaType ? (
                    <span className="template-tags">
                      {template.models.slice(0, 3).map((model) => (
                        <span className="template-tag" key={model}>
                          {model}
                        </span>
                      ))}
                      {template.mediaType ? (
                        <span className="template-tag">{template.mediaType}</span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {selected ? (
        <div
          className="picker-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!importing) setSelected(null);
          }}
        >
          <div className="picker-sheet template-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{selected.title}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setSelected(null)}
              >
                <Icon name="close" size={20} />
              </button>
            </div>
            <div className="template-sheet-body">
              {selected.description ? <p>{selected.description}</p> : null}
              {selected.tags.length ? (
                <div className="template-tags">
                  {selected.tags.map((tag) => (
                    <span className="template-tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              {selected.requiresApi ? (
                <p className="template-warning">
                  这个模板使用 ComfyUI 云端 API 节点，需要先在 ComfyUI 中配置 API Key，
                  否则运行时会失败。
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="button primary"
              disabled={importing !== null}
              onClick={() => void useTemplate(selected)}
            >
              {importing === selected.name ? (
                <Spinner size={18} label="创建中…" />
              ) : (
                <Icon name="spark" size={18} />
              )}
              使用此模板
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
