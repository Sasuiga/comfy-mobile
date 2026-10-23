import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DEFAULT_GROUPS, FIELD_KINDS } from '@comfy-mobile/shared';
import type {
  Field,
  FieldGroup,
  FieldKind,
  FieldOverride,
  WorkflowDetail,
} from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { Icon } from '../components/Icon';
import {
  ErrorBox,
  PageHeader,
  Spinner,
  usePageTitle,
} from '../components/UI';
import { useApp } from '../context';
import { zh } from '../i18n';

interface Draft {
  key: string;
  label: string;
  description: string;
  group: string;
  kind: FieldKind;
  visible: boolean;
}

function buildDrafts(detail: WorkflowDetail): Draft[] {
  return detail.fields.map((field) => ({
    key: field.key,
    label: field.label,
    description: field.description ?? '',
    group: field.group,
    kind: field.kind,
    visible: field.visible,
  }));
}

const SOURCE_LABELS: Record<Field['source'], string> = {
  override: '自定义',
  linear: 'App',
  marker: '标记',
  heuristic: '自动',
};

export function FormEditorPage() {
  usePageTitle(zh.editor.title);
  const { key = '' } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const { showToast } = useApp();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [initialOrder, setInitialOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  const applyDetail = useCallback((next: WorkflowDetail): void => {
    setDetail(next);
    setFields(next.fields);
    setDrafts(buildDrafts(next));
    setInitialOrder(next.fields.map((field) => field.key));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      applyDetail(await api.getWorkflow(key));
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [applyDetail, key]);

  useEffect(() => {
    void load();
  }, [load]);

  const originals = useMemo(() => {
    const map = new Map<string, Field>();
    for (const field of fields) map.set(field.key, field);
    return map;
  }, [fields]);

  const groupOptions = useMemo(() => {
    const map = new Map<string, FieldGroup>();
    for (const group of DEFAULT_GROUPS) map.set(group.id, group);
    for (const group of detail?.groups ?? []) {
      if (!map.has(group.id)) map.set(group.id, group);
    }
    return [...map.values()].sort((a, b) => a.order - b.order);
  }, [detail]);

  const dirty = useMemo(() => {
    if (drafts.length !== initialOrder.length) return true;
    return drafts.some((draft, index) => {
      const original = originals.get(draft.key);
      if (!original) return true;
      return (
        initialOrder[index] !== draft.key ||
        draft.visible !== original.visible ||
        draft.label !== original.label ||
        draft.description !== (original.description ?? '') ||
        draft.group !== original.group ||
        draft.kind !== original.kind
      );
    });
  }, [drafts, initialOrder, originals]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = drafts.map((draft, index) => ({ draft, index }));
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.draft.label.toLowerCase().includes(q) ||
        row.draft.key.toLowerCase().includes(q),
    );
  }, [drafts, query]);

  const update = (keyValue: string, patch: Partial<Draft>): void => {
    setDrafts((items) =>
      items.map((item) => (item.key === keyValue ? { ...item, ...patch } : item)),
    );
  };

  const move = (index: number, direction: -1 | 1): void => {
    setDrafts((items) => {
      const target = index + direction;
      if (target < 0 || target >= items.length) return items;
      const next = [...items];
      const current = next[index];
      const other = next[target];
      if (!current || !other) return items;
      next[index] = other;
      next[target] = current;
      return next;
    });
  };

  const save = async (andBack: boolean): Promise<void> => {
    if (drafts.some((draft) => !draft.label.trim())) {
      setSaveError('显示名称不能为空');
      return;
    }
    // The API replaces the whole override list, so save the complete form.
    // Field values (constraints, options, defaults) still come from ComfyUI.
    const overrides: FieldOverride[] = [];
    for (const [index, draft] of drafts.entries()) {
      const original = originals.get(draft.key);
      if (!original) continue;
      overrides.push({
        key: draft.key,
        label: draft.label.trim(),
        description: draft.description.trim(),
        group: draft.group,
        kind: draft.kind,
        order: index,
        visible: draft.visible,
        advanced: draft.group === 'advanced',
      });
    }

    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.saveFields(key, overrides);
      applyDetail(next);
      setQuery('');
      showToast('表单设置已保存', 'success');
      if (andBack) navigate(`/w/${encodeURIComponent(key)}`);
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    if (!window.confirm(zh.editor.resetConfirm)) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.resetFields(key);
      applyDetail(next);
      setQuery('');
      showToast('已恢复默认表单', 'success');
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeWorkflow = async (): Promise<void> => {
    if (!detail || detail.source !== 'imported') return;
    if (!window.confirm(`删除导入的工作流「${detail.name}」及其预设？`)) return;
    try {
      await api.deleteWorkflow(key);
      showToast('工作流已删除', 'success');
      navigate('/');
    } catch (cause) {
      setSaveError(errorMessage(cause));
    }
  };

  if (loading) {
    return (
      <div className="page">
        <PageHeader title={zh.editor.title} back={`/w/${encodeURIComponent(key)}`} />
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="page">
        <PageHeader title={zh.editor.title} back="/" />
        <ErrorBox message={loadError ?? '工作流不存在'} onRetry={() => void load()} />
      </div>
    );
  }

  const hiddenCount = drafts.filter((draft) => !draft.visible).length;

  return (
    <div className="page editor-page">
      <PageHeader
        title={zh.editor.title}
        back={`/w/${encodeURIComponent(key)}`}
        subtitle={detail.name}
      />

      <p className="editor-hint">{zh.editor.hint}</p>

      {detail.staleOverrides.length ? (
        <div className="warn-banner always-open">
          <div className="warn-head">
            <Icon name="alert" size={18} />
            <span>{zh.editor.stale}</span>
          </div>
          <ul>
            {detail.staleOverrides.map((item) => <li key={item}><code>{item}</code></li>)}
          </ul>
        </div>
      ) : null}

      {saveError ? <ErrorBox message={saveError} /> : null}

      <div className="toolbar">
        <div className="search-field">
          <Icon name="search" size={18} />
          <input
            value={query}
            placeholder="搜索字段名称或键"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className="clear-button" aria-label={zh.common.close} onClick={() => setQuery('')}>
              <Icon name="close" size={16} />
            </button>
          ) : null}
        </div>
        <span className="editor-stats">
          {drafts.length - hiddenCount} 显示 / {hiddenCount} 隐藏
        </span>
      </div>

      <div className="editor-list">
        {filtered.map(({ draft, index }) => {
          const original = originals.get(draft.key);
          const searchActive = Boolean(query.trim());
          return (
            <div key={draft.key} className={`editor-row${draft.visible ? '' : ' hidden-field'}`}>
              <div className="editor-row-top">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.visible}
                    onChange={(event) => update(draft.key, { visible: event.target.checked })}
                  />
                  显示
                </label>
                <span className="source-badge">{original ? SOURCE_LABELS[original.source] : '自动'}</span>
                <code className="editor-key" title={draft.key}>{draft.key}</code>
              </div>

              <input
                className="input editor-label-input"
                value={draft.label}
                maxLength={80}
                aria-label={zh.editor.label}
                placeholder={zh.editor.label}
                onChange={(event) => update(draft.key, { label: event.target.value })}
              />

              <div className="editor-selects">
                <label>
                  <span>{zh.editor.group}</span>
                  <select
                    className="input select compact"
                    value={draft.group}
                    onChange={(event) => update(draft.key, { group: event.target.value })}
                  >
                    {groupOptions.map((group) => (
                      <option key={group.id} value={group.id}>{group.label}</option>
                    ))}
                    {!groupOptions.some((group) => group.id === draft.group) ? (
                      <option value={draft.group}>{draft.group}</option>
                    ) : null}
                  </select>
                </label>
                <label>
                  <span>{zh.editor.kind}</span>
                  <select
                    className="input select compact"
                    value={draft.kind}
                    onChange={(event) => update(draft.key, { kind: event.target.value as FieldKind })}
                  >
                    {FIELD_KINDS.map((kind) => (
                      <option key={kind} value={kind}>{zh.field[kind]}</option>
                    ))}
                  </select>
                </label>
              </div>

              <details className="editor-details">
                <summary>更多设置</summary>
                <label className="field">
                  <span className="field-label">{zh.editor.description}</span>
                  <textarea
                    className="input textarea"
                    rows={2}
                    maxLength={300}
                    value={draft.description}
                    onChange={(event) => update(draft.key, { description: event.target.value })}
                  />
                </label>
                <div className="editor-order">
                  <button
                    type="button"
                    className="icon-button bordered"
                    aria-label={zh.editor.moveUp}
                    title={zh.editor.moveUp}
                    disabled={searchActive || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <Icon name="arrow-up" size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-button bordered"
                    aria-label={zh.editor.moveDown}
                    title={zh.editor.moveDown}
                    disabled={searchActive || index === drafts.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <Icon name="arrow-down" size={18} />
                  </button>
                  <span>位置 {index + 1} / {drafts.length}</span>
                </div>
                {searchActive ? <p className="field-desc">搜索时无法调整顺序。</p> : null}
                {original ? (
                  <p className="field-desc">
                    节点 <code>{original.nodeId}</code> · 输入 <code>{original.input}</code>
                    {original.advanced ? ' · 高级参数' : ''}
                  </p>
                ) : null}
              </details>
            </div>
          );
        })}
        {filtered.length === 0 ? <p className="muted-note">没有匹配的字段。</p> : null}
      </div>

      {detail.source === 'imported' ? (
        <button type="button" className="text-button danger remove-workflow" onClick={() => void removeWorkflow()}>
          <Icon name="trash" size={16} />
          删除这个导入的工作流
        </button>
      ) : null}

      <div className="run-bar editor-bar">
        <button
          type="button"
          className="button ghost"
          disabled={saving}
          onClick={() => void reset()}
        >
          {zh.editor.reset}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={saving || !dirty}
          onClick={() => void save(false)}
        >
          {saving ? <Spinner size={18} /> : zh.common.save}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={saving}
          onClick={() => void save(true)}
        >
          保存并返回
        </button>
      </div>
    </div>
  );
}
