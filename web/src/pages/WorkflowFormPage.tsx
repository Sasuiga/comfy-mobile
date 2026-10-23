import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_GROUPS, DEFAULT_PROJECT, projectDisplayTitle } from '@comfy-mobile/shared';
import type { Field, Preset, WorkflowDetail } from '@comfy-mobile/shared';
import { api, ApiError, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { FieldControl, FieldRow, type FieldNotice } from '../components/FieldControl';
import { Icon } from '../components/Icon';
import { MultiImageUpload } from '../components/MultiImageUpload';
import { WorkflowWarnings } from '../components/WorkflowWarnings';
import { parseWorkflowWarnings } from '../warnings';
import {
  EmptyState,
  ErrorBox,
  Modal,
  PageHeader,
  SectionCard,
  Spinner,
  usePageTitle,
} from '../components/UI';
import { rememberWorkflow } from '../recent';

interface RunStateValues {
  values?: Record<string, unknown>;
  /** Nodes that were bypassed when the run was submitted. */
  bypassedNodes?: string[];
  /** Set when the user comes back from a failed run to fix the offending node. */
  nodeError?: { nodeId?: string; message?: string };
}

function groupLabel(id: string): string {
  const preset = DEFAULT_GROUPS.find((group) => group.id === id);
  return preset?.label ?? id;
}

function sameNodeId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);
}

function isSkippedField(field: Field, value: unknown): boolean {
  return Boolean(field.skippable) && value === null;
}

/** Display name for a node-level bypass control. */
function nodeLabel(field: Field): string {
  return field.nodeTitle ?? field.nodeClass ?? `节点 ${field.nodeId}`;
}

/**
 * Conversion warnings carry a node id and an input name. Map them back to the
 * visible fields so the form itself can show where the fix belongs instead of
 * leaving everything in the banner at the top.
 */
function buildFieldNotices(
  detail: WorkflowDetail,
  values: Record<string, unknown>,
): Map<string, FieldNotice> {
  const notices = new Map<string, FieldNotice>();
  const parsed = parseWorkflowWarnings(detail.warnings, detail.missingNodeTypes);
  const visible = detail.fields.filter((field) => field.visible);
  for (const item of parsed.items) {
    if (!item.nodeId) continue;
    const nodeFields = visible.filter((field) => sameNodeId(field.nodeId, item.nodeId));
    if (!nodeFields.length) continue;

    let targets: Field[] = [];
    let notice: FieldNotice | undefined;
    if (item.kind === 'asset' && !item.placeholder) {
      targets = nodeFields.filter(
        (field) => item.field && (field.input === item.field || field.widgetName === item.field),
      );
      notice = {
        level: 'warn',
        message: `资源缺失：${item.savedValue || '该文件'} 在当前 ComfyUI 上不存在，请重新选择`,
      };
    } else if (item.kind === 'param') {
      targets = nodeFields.filter(
        (field) => item.field && (field.input === item.field || field.widgetName === item.field),
      );
      notice = {
        level: 'warn',
        message: `选项已失效：${item.savedValue || '原值'}，已自动替换为 ${
          item.replacement || '默认值'
        }，请重新选择`,
      };
    } else if (item.kind === 'shift') {
      targets = nodeFields;
      notice = {
        level: 'danger',
        message: '参数与当前节点定义不匹配，请重新选择，或到 ComfyUI 重新保存工作流',
      };
    }
    if (!notice || !targets.length) continue;

    for (const field of targets) {
      const current = values[field.key];
      // These warnings describe the saved value. Once the user uploads or
      // picks something else — or cancels the slot — the warning is resolved.
      if (item.kind === 'asset') {
        if (isSkippedField(field, current)) continue;
        if (current !== undefined && current !== item.savedValue) continue;
      }
      if (item.kind === 'param' && item.replacement !== undefined) {
        if (typeof current === 'string' && current !== item.replacement) continue;
      }
      const existing = notices.get(field.key);
      if (!existing || (existing.level === 'warn' && notice.level === 'danger')) {
        notices.set(field.key, notice);
      }
    }
  }
  return notices;
}

function defaultValues(detail: WorkflowDetail): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of detail.fields) {
    if (!field.visible) continue;
    if (field.default === undefined || field.default === null) continue;
    values[field.key] = field.default;
  }
  return values;
}

export function WorkflowFormPage() {
  const { key = '' } = useParams<{ key: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const project = searchParams.get('project')?.trim() || DEFAULT_PROJECT;
  const projectQuery = `?project=${encodeURIComponent(project)}`;
  const projectHref = `/p/${encodeURIComponent(project)}`;
  const { showToast } = useApp();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [randomizeSeeds, setRandomizeSeeds] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [presetModal, setPresetModal] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Nodes the user bypassed for debugging; their fields are left out. */
  const [bypassed, setBypassed] = useState<Set<string>>(new Set());

  const stateValues = (location.state as RunStateValues | null)?.values;
  const stateBypassed = (location.state as RunStateValues | null)?.bypassedNodes;
  const stateNodeError = (location.state as RunStateValues | null)?.nodeError;

  /** Bring a field into view after its section has been expanded. */
  const focusField = (fieldKey: string): void => {
    window.setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>('[data-field-key]')].find(
        (element) => element.dataset.fieldKey === fieldKey,
      );
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.getWorkflow(key);
      setDetail(next);
      setCollapsed(
        new Set(next.groups.filter((group) => group.collapsed).map((group) => group.id)),
      );
      const defaults = defaultValues(next);
      if (stateValues) {
        for (const [name, value] of Object.entries(stateValues)) {
          if (next.fields.some((field) => field.key === name)) defaults[name] = value;
        }
      }
      setValues(defaults);
      if (stateBypassed?.length) {
        const allowed = new Set(
          next.fields.filter((field) => field.nodeBypassable).map((field) => field.nodeId),
        );
        setBypassed(new Set(stateBypassed.filter((nodeId) => allowed.has(nodeId))));
      }
      if (stateNodeError?.nodeId) {
        const nodeFields = next.fields.filter(
          (field) => field.visible && sameNodeId(field.nodeId, stateNodeError.nodeId),
        );
        const first = nodeFields[0];
        if (first) {
          setErrors({
            [first.key]: stateNodeError.message
              ? `节点执行失败：${stateNodeError.message}`
              : '该节点执行失败，请检查这里的参数',
          });
          setCollapsed((current) => {
            const expanded = new Set(current);
            expanded.delete(first.group);
            return expanded;
          });
          focusField(first.key);
        }
      }
      rememberWorkflow(key);
      const presetResponse = await api.listPresets(key).catch(() => ({ presets: [] as Preset[] }));
      setPresets(presetResponse.presets);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [key, stateValues, stateBypassed, stateNodeError]);

  useEffect(() => {
    void load();
    // Reloading when the route key changes is the intended behaviour; location
    // state is only read on the first load for a given key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const title = detail?.name ?? '工作流';
  usePageTitle(title);

  const visibleGroups = useMemo(() => {
    if (!detail) return [];
    return detail.groups
      .map((group) => ({
        ...group,
        label: group.label || groupLabel(group.id),
        fields: detail.fields.filter((field) => field.visible && field.group === group.id),
      }))
      .filter((group) => group.fields.length > 0);
  }, [detail]);

  const visibleFields = useMemo(
    () => detail?.fields.filter((field) => field.visible) ?? [],
    [detail],
  );

  /** Conversion warnings mapped to the fields the user can actually fix. */
  const fieldNotices = useMemo(
    () => (detail ? buildFieldNotices(detail, values) : new Map<string, FieldNotice>()),
    [detail, values],
  );

  const groupIssues = useMemo(() => {
    const map = new Map<string, { count: number; level: 'warn' | 'danger' }>();
    for (const field of visibleFields) {
      // Bypassed nodes are not part of the prompt, so their warnings and
      // validation errors are irrelevant for this run.
      if (bypassed.has(field.nodeId)) continue;
      const issue = errors[field.key]
        ? { level: 'danger' as const }
        : fieldNotices.get(field.key);
      if (!issue) continue;
      const entry = map.get(field.group) ?? { count: 0, level: 'warn' as 'warn' | 'danger' };
      entry.count += 1;
      if (issue.level === 'danger') entry.level = 'danger';
      map.set(field.group, entry);
    }
    return map;
  }, [visibleFields, errors, fieldNotices, bypassed]);

  /**
   * Cancelling a media slot bypasses its loader node, so it works even when a
   * downstream node marks the input as required.
   */
  const toggleSlot = (field: Field): void => {
    if (!field.skippable) {
      showToast('该槽位不能绕过，请改为上传或选择文件', 'error');
      return;
    }
    const skipped = isSkippedField(field, values[field.key]);
    setValue(field, skipped ? '' : null);
    if (!skipped) showToast(`已绕过「${field.label}」`, 'info');
  };

  /** Bypass a whole node, matching ComfyUI's bypass (Ctrl+B) behaviour. */
  const toggleNodeBypass = (nodeId: string): void => {
    const wasBypassed = bypassed.has(nodeId);
    setBypassed((current) => {
      const next = new Set(current);
      if (wasBypassed) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    showToast(
      wasBypassed ? '已取消绕过，节点重新参与运行' : '已绕过该节点，本次运行不执行它',
      wasBypassed ? 'success' : 'info',
    );
    setErrors((current) => {
      let changed = false;
      const next = { ...current };
      for (const field of visibleFields) {
        if (field.nodeId === nodeId && next[field.key]) {
          delete next[field.key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  };

  /** Expand every section that currently holds a problem and jump to the first. */
  const revealIssues = (keys: string[]): void => {
    if (!keys.length || !detail) return;
    setCollapsed((current) => {
      const next = new Set(current);
      for (const fieldKey of keys) {
        const field = detail.fields.find((item) => item.key === fieldKey);
        if (field) next.delete(field.group);
      }
      return next;
    });
    focusField(keys[0]!);
  };

  const setValue = (field: Field, value: unknown): void => {
    setValues((current) => ({ ...current, [field.key]: value }));
    setErrors((current) => {
      if (!current[field.key]) return current;
      const next = { ...current };
      delete next[field.key];
      return next;
    });
  };

  const applyValues = (assignments: { key: string; value: unknown }[]): void => {
    setValues((current) => {
      const next = { ...current };
      for (const item of assignments) next[item.key] = item.value;
      return next;
    });
    setErrors((current) => {
      if (!assignments.some((item) => current[item.key])) return current;
      const next = { ...current };
      for (const item of assignments) delete next[item.key];
      return next;
    });
  };

  const applyPreset = (id: string): void => {
    setPresetId(id);
    if (!id) return;
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    setValues((current) => {
      const next = { ...current };
      for (const [name, value] of Object.entries(preset.values)) {
        if (detail?.fields.some((field) => field.key === name)) next[name] = value;
      }
      return next;
    });
    setRandomizeSeeds(Boolean(preset.randomizeSeeds));    showToast(`已应用预设「${preset.name}」`, 'success');
  };

  const savePreset = async (): Promise<void> => {
    const name = presetName.trim();
    if (!name) {
      setPresetError(zh.form.presetName);
      return;
    }
    setSavingPreset(true);
    setPresetError(null);
    try {
      const payload: Record<string, unknown> = {};
      for (const field of visibleFields) {
        if (Object.prototype.hasOwnProperty.call(values, field.key)) payload[field.key] = values[field.key];
      }
      const response = await api.createPreset(key, {
        name,
        values: payload,
        randomizeSeeds,
      });
      setPresets((items) => [...items, response.preset]);
      setPresetId(response.preset.id);
      setPresetModal(false);
      setPresetName('');
      showToast('预设已保存', 'success');
    } catch (cause) {
      setPresetError(errorMessage(cause));
    } finally {
      setSavingPreset(false);
    }
  };

  const deletePreset = async (): Promise<void> => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) return;
    if (!window.confirm(`删除预设「${preset.name}」？`)) return;
    try {
      await api.deletePreset(key, preset.id);
      setPresets((items) => items.filter((item) => item.id !== preset.id));
      setPresetId('');
      showToast('预设已删除', 'success');
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    }
  };

  const submit = async (): Promise<void> => {
    if (!detail) return;
    const nextErrors: Record<string, string> = {};
    for (const field of visibleFields) {
      // Bypassed nodes are dropped from the prompt; their fields do not need
      // to be filled.
      if (bypassed.has(field.nodeId)) continue;
      const value = values[field.key];
      // A cancelled media slot is intentionally empty (null when the slot was
      // bypassed, "" when the file was just cleared).
      if (field.skippable && (value === null || value === '')) {
        continue;
      }
      if (!field.required) continue;
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        nextErrors[field.key] = `${field.label} 不能为空`;
      }
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      setSubmitError('请先补全必填参数');
      revealIssues(Object.keys(nextErrors));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setErrors({});
    try {
      const response = await api.submitRun({
        workflowKey: key,
        values,
        project,
        randomizeSeeds,
        ...(bypassed.size ? { bypass: [...bypassed] } : {}),
      });
      navigate(`/runs/${response.runId}`);
    } catch (cause) {
      let message = errorMessage(cause);
      if (cause instanceof ApiError && cause.code === 'NODE_ERRORS') {
        const details = cause.details as {
          nodeErrors?: Array<{ fieldKey?: string; message: string }>;
        };
        const mapped: Record<string, string> = {};
        const unmapped: string[] = [];
        for (const item of details.nodeErrors ?? []) {
          if (item.fieldKey) mapped[item.fieldKey] = item.message;
          else unmapped.push(item.message);
        }
        if (Object.keys(mapped).length) {
          setErrors(mapped);
          revealIssues(Object.keys(mapped));
        }
        if (unmapped.length) message = `${message}：${unmapped.join('；')}`;
      } else if (cause instanceof ApiError) {
        // Server-side validation attaches the field key to the error details.
        const fieldKey = (cause.details as { key?: unknown } | undefined)?.key;
        if (typeof fieldKey === 'string' && detail.fields.some((field) => field.key === fieldKey)) {
          setErrors({ [fieldKey]: cause.message });
          revealIssues([fieldKey]);
        }
      }
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <PageHeader title="加载工作流" back={projectHref} />
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="page">
        <PageHeader title="工作流" back={projectHref} />
        <ErrorBox message={loadError ?? '工作流不存在'} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="page form-page">
      <PageHeader
        title={detail.name}
        back={projectHref}
        subtitle={
          <span className="header-chips">
            <span className="project-tag">{projectDisplayTitle(project)}</span>
            <span className={`format-badge ${detail.hasAppConfig ? 'app' : detail.format ?? 'ui'}`}>
              {detail.hasAppConfig ? zh.workflow.appMode : detail.format === 'api' ? zh.workflow.apiFormat : zh.workflow.uiFormat}
            </span>
            <span>{visibleFields.length} {zh.workflow.fields}</span>
          </span>
        }
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label={zh.form.editForm}
            title={zh.form.editForm}
            onClick={() => navigate(`/w/${encodeURIComponent(key)}/edit${projectQuery}`)}
          >
            <Icon name="edit" />
          </button>
        }
      />

      <WorkflowWarnings
        warnings={detail.warnings}
        missingNodeTypes={detail.missingNodeTypes}
      />

      {visibleFields.length === 0 ? (
        <EmptyState
          icon="settings"
          title="没有可编辑的参数"
          hint="这个工作流没有识别到主参数。可以进入表单编辑器手动显示需要的字段。"
          action={
            <button
              type="button"
              className="button secondary"
              onClick={() => navigate(`/w/${encodeURIComponent(key)}/edit${projectQuery}`)}
            >
              {zh.form.editForm}
            </button>
          }
        />
      ) : (
        <>
          <div className="preset-bar">
            <select
              className="input select compact"
              value={presetId}
              onChange={(event) => applyPreset(event.target.value)}
              aria-label={zh.form.choosePreset}
            >
              <option value="">{presets.length ? zh.form.choosePreset : zh.form.noPreset}</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button bordered"
              title={zh.form.savePreset}
              aria-label={zh.form.savePreset}
              onClick={() => { setPresetModal(true); setPresetError(null); }}
            >
              <Icon name="plus" size={20} />
            </button>
            {presetId ? (
              <button
                type="button"
                className="icon-button bordered danger"
                title={zh.common.delete}
                aria-label={zh.common.delete}
                onClick={() => void deletePreset()}
              >
                <Icon name="trash" size={19} />
              </button>
            ) : null}
          </div>

          <div className="form-groups">
            {visibleGroups.map((group) => {
              const isCollapsed = collapsed.has(group.id);
              const imageFields = group.fields.filter((field) => field.kind === 'image');
              const activeImageFields = imageFields.filter(
                (field) =>
                  !bypassed.has(field.nodeId) && !isSkippedField(field, values[field.key]),
              );
              const issue = groupIssues.get(group.id);
              return (
                <SectionCard
                  key={group.id}
                  title={group.label}
                  tone={issue?.level}
                  badge={
                    issue ? (
                      <>
                        <Icon name="alert" size={12} />
                        {issue.count} 项待处理
                      </>
                    ) : undefined
                  }
                  actions={
                    <button
                      type="button"
                      className={`collapse-button${isCollapsed ? ' collapsed' : ''}`}
                      aria-label={isCollapsed ? '展开' : '收起'}
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })
                      }
                    >
                      <Icon name="chevron" size={18} />
                    </button>
                  }
                >
                  {isCollapsed ? (
                    <p className="collapsed-hint">
                      {group.fields.length} 个参数已收起
                      {issue ? ` · ${issue.count} 项待处理` : ''}
                    </p>
                  ) : (
                    <>
                      {imageFields.length > 1 && activeImageFields.length ? (
                        <MultiImageUpload
                          fields={activeImageFields}
                          values={values}
                          disabled={submitting}
                          project={project}
                          onApply={applyValues}
                        />
                      ) : null}
                      <div className="field-list">
                        {group.fields.map((field, index) => {
                          const previous = group.fields[index - 1];
                          const startsNode = !previous || previous.nodeId !== field.nodeId;
                          const nodeBypassed = bypassed.has(field.nodeId);
                          const showNodeToggle = startsNode && Boolean(field.nodeBypassable);
                          const nodeRow = showNodeToggle ? (
                            <div
                              className={`node-bypass${nodeBypassed ? ' is-bypassed' : ''}`}
                            >
                              <span className="node-bypass-label">
                                <span>{nodeLabel(field)}</span>
                                {field.nodeClass && field.nodeClass !== nodeLabel(field) ? (
                                  <small>{field.nodeClass}</small>
                                ) : null}
                              </span>
                              <button
                                type="button"
                                className={`text-button node-bypass-toggle${
                                  nodeBypassed ? ' restore' : ''
                                }`}
                                title={
                                  nodeBypassed
                                    ? '恢复节点，使其重新参与运行'
                                    : '绕过该节点（与 ComfyUI 的 Ctrl+B 相同），便于对比调试'
                                }
                                onClick={() => toggleNodeBypass(field.nodeId)}
                              >
                                {nodeBypassed ? '恢复节点' : '绕过'}
                              </button>
                            </div>
                          ) : null;
                          // A bypassed node is dropped from the prompt, so hide
                          // its controls until the user restores it.
                          if (nodeBypassed) {
                            return (
                              <Fragment key={field.key}>
                                {nodeRow}
                                {startsNode ? (
                                  <p className="node-bypass-hint">
                                    该节点已绕过，本次运行不会执行它。
                                  </p>
                                ) : null}
                              </Fragment>
                            );
                          }
                          return (
                            <Fragment key={field.key}>
                              {nodeRow}
                              <FieldRow
                                field={field}
                                error={errors[field.key]}
                                warning={fieldNotices.get(field.key)}
                                skipped={isSkippedField(field, values[field.key])}
                                onToggleSkip={
                                  field.skippable ? () => toggleSlot(field) : undefined
                                }
                              >
                                <FieldControl
                                  field={field}
                                  value={values[field.key]}
                                  error={errors[field.key]}
                                  disabled={submitting}
                                  compact={imageFields.length > 1}
                                  project={project}
                                  onChange={(value) => setValue(field, value)}
                                />
                              </FieldRow>
                            </Fragment>
                          );
                        })}
                      </div>
                    </>
                  )}
                </SectionCard>
              );
            })}
          </div>

          {submitError ? (
            <div className="submit-error" role="alert">
              <Icon name="alert" size={20} />
              <span>{submitError}</span>
            </div>
          ) : null}

          <div className="run-bar">
            <label className="random-toggle">
              <input
                type="checkbox"
                checked={randomizeSeeds}
                onChange={(event) => setRandomizeSeeds(event.target.checked)}
              />
              <span>{zh.form.randomSeed}</span>
            </label>
            <button
              type="button"
              className="button primary run-button"
              disabled={submitting}
              onClick={() => void submit()}
            >
              {submitting ? (
                <Spinner size={20} label={zh.form.running} />
              ) : (
                <>
                  <Icon name="play" size={20} />
                  {zh.form.run}
                </>
              )}
            </button>
          </div>
        </>
      )}

      <Modal
        title={zh.form.savePreset}
        open={presetModal}
        onClose={() => setPresetModal(false)}
        footer={
          <>
            <button type="button" className="button ghost" onClick={() => setPresetModal(false)}>
              {zh.common.cancel}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={savingPreset}
              onClick={() => void savePreset()}
            >
              {savingPreset ? <Spinner size={18} /> : zh.common.save}
            </button>
          </>
        }
      >
        <label className="field">
          <span className="field-label">{zh.form.presetName}</span>
          <input
            className="input"
            autoFocus
            value={presetName}
            maxLength={100}
            placeholder="例如：夜景、人像特写"
            onChange={(event) => setPresetName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void savePreset();
            }}
          />
        </label>
        {presetError ? <p className="field-error">{presetError}</p> : null}
        <p className="field-desc">
          当前可见参数（{visibleFields.length} 个）会保存到此预设。
        </p>
      </Modal>
    </div>
  );
}
