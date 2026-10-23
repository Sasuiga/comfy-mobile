import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { DEFAULT_GROUPS } from '@comfy-mobile/shared';
import type { Field, Preset, WorkflowDetail } from '@comfy-mobile/shared';
import { api, ApiError, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { FieldControl, FieldRow } from '../components/FieldControl';
import { Icon } from '../components/Icon';
import {
  EmptyState,
  ErrorBox,
  Modal,
  PageHeader,
  SectionCard,
  Spinner,
  usePageTitle,
} from '../components/UI';
import { rememberWorkflow } from './WorkflowsPage';

interface RunStateValues {
  values?: Record<string, unknown>;
}

function groupLabel(id: string): string {
  const preset = DEFAULT_GROUPS.find((group) => group.id === id);
  return preset?.label ?? id;
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['advanced']));
  const [showWarnings, setShowWarnings] = useState(false);

  const stateValues = (location.state as RunStateValues | null)?.values;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.getWorkflow(key);
      setDetail(next);
      const defaults = defaultValues(next);
      if (stateValues) {
        for (const [name, value] of Object.entries(stateValues)) {
          if (next.fields.some((field) => field.key === name)) defaults[name] = value;
        }
      }
      setValues(defaults);
      rememberWorkflow(key);
      const presetResponse = await api.listPresets(key).catch(() => ({ presets: [] as Preset[] }));
      setPresets(presetResponse.presets);
    } catch (cause) {
      setLoadError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [key, stateValues]);

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

  const setValue = (field: Field, value: unknown): void => {
    setValues((current) => ({ ...current, [field.key]: value }));
    setErrors((current) => {
      if (!current[field.key]) return current;
      const next = { ...current };
      delete next[field.key];
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
      if (!field.required) continue;
      const value = values[field.key];
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        nextErrors[field.key] = `${field.label} 不能为空`;
      }
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      setSubmitError('请先补全必填参数');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setErrors({});
    try {
      const response = await api.submitRun({
        workflowKey: key,
        values,
        randomizeSeeds,
      });
      navigate(`/runs/${response.runId}`);
    } catch (cause) {
      setSubmitError(errorMessage(cause));
      if (cause instanceof ApiError && cause.code === 'NODE_ERRORS') {
        const details = cause.details as {
          nodeErrors?: Array<{ fieldKey?: string; message: string }>;
        };
        const mapped: Record<string, string> = {};
        for (const item of details.nodeErrors ?? []) {
          if (item.fieldKey) mapped[item.fieldKey] = item.message;
        }
        setErrors(mapped);
        setCollapsed((current) => {
          const next = new Set(current);
          for (const fieldKey of Object.keys(mapped)) {
            const field = detail.fields.find((item) => item.key === fieldKey);
            if (field) next.delete(field.group);
          }
          return next;
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <PageHeader title="加载工作流" back="/" />
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="page">
        <PageHeader title="工作流" back="/" />
        <ErrorBox message={loadError ?? '工作流不存在'} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="page form-page">
      <PageHeader
        title={detail.name}
        back="/"
        subtitle={
          <span className="header-chips">
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
            onClick={() => navigate(`/w/${encodeURIComponent(key)}/edit`)}
          >
            <Icon name="edit" />
          </button>
        }
      />

      {detail.warnings.length || detail.missingNodeTypes.length ? (
        <div className="warn-banner">
          <button type="button" onClick={() => setShowWarnings((value) => !value)}>
            <Icon name="alert" size={18} />
            <span>
              工作流转换提示
              {detail.missingNodeTypes.length ? ` · ${detail.missingNodeTypes.length} 个节点缺失` : ''}
            </span>
            <Icon name="chevron" size={16} className={showWarnings ? 'rotated' : ''} />
          </button>
          {showWarnings ? (
            <ul>
              {detail.missingNodeTypes.map((item) => (
                <li key={item.nodeId}>{item.warning}</li>
              ))}
              {detail.warnings.map((warning, index) => (
                <li key={`warn-${index}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {visibleFields.length === 0 ? (
        <EmptyState
          icon="settings"
          title="没有可编辑的参数"
          hint="这个工作流没有识别到主参数。可以进入表单编辑器手动显示需要的字段。"
          action={
            <button
              type="button"
              className="button secondary"
              onClick={() => navigate(`/w/${encodeURIComponent(key)}/edit`)}
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
              return (
                <SectionCard
                  key={group.id}
                  title={group.label}
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
                    </p>
                  ) : (
                    <div className="field-list">
                      {group.fields.map((field) => (
                        <FieldRow key={field.key} field={field} error={errors[field.key]}>
                          <FieldControl
                            field={field}
                            value={values[field.key]}
                            error={errors[field.key]}
                            disabled={submitting}
                            onChange={(value) => setValue(field, value)}
                          />
                        </FieldRow>
                      ))}
                    </div>
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
