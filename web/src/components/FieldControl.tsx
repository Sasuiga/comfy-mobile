import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isAssetRef, type Field } from '@comfy-mobile/shared';
import { api, assetUrl, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { AssetPicker } from './AssetPicker';
import { Icon } from './Icon';
import { Spinner } from './UI';

export interface FieldControlProps {
  field: Field;
  value: unknown;
  error?: string;
  disabled?: boolean;
  /** Denser layout used when a workflow has many reference-image slots. */
  compact?: boolean;
  /** Project that owns uploaded assets and the asset picker. */
  project?: string;
  onChange: (value: unknown) => void;
}

function StringInput({
  field,
  value,
  disabled,
  onChange,
}: FieldControlProps) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  if (field.kind === 'textarea') {
    const rows = Math.min(12, Math.max(3, Math.ceil(text.length / 42) + 1));
    return (
      <div className="textarea-wrap">
        <textarea
          className="input textarea"
          value={text}
          rows={text.length > 0 ? rows : 4}
          maxLength={field.constraints.maxLength}
          placeholder={field.description || '输入内容'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {text && !disabled ? (
          <button
            type="button"
            className="clear-button textarea-clear"
            title="清空内容"
            aria-label="清空内容"
            // Keep the textarea focused so the on-screen keyboard stays open.
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange('')}
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <input
      className="input"
      type="text"
      value={text}
      maxLength={field.constraints.maxLength}
      placeholder={field.description || '输入内容'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function NumberInput({
  field,
  value,
  disabled,
  onChange,
  compact,
}: FieldControlProps & { compact?: boolean }) {
  const [draft, setDraft] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => {
    setDraft(value === undefined || value === null ? '' : String(value));
  }, [value]);

  const commit = (text: string): void => {
    setDraft(text);
    if (text.trim() === '') return;
    const number = Number(text);
    if (Number.isFinite(number)) onChange(number);
  };
  const step = field.constraints.step ?? (field.constraints.integer ? 1 : 0.01);
  return (
    <div className={`number-row${compact ? ' compact' : ''}`}>
      <button
        type="button"
        className="stepper"
        aria-label="减少"
        disabled={disabled}
        onClick={() => onChange(Number(draft || 0) - step)}
      >
        −
      </button>
      <input
        className="input number-input"
        type="number"
        inputMode={field.constraints.integer ? 'numeric' : 'decimal'}
        value={draft}
        min={field.constraints.min}
        max={field.constraints.max}
        step={step}
        disabled={disabled}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => {
          if (draft.trim() === '') setDraft(value === undefined || value === null ? '' : String(value));
        }}
      />
      <button
        type="button"
        className="stepper"
        aria-label="增加"
        disabled={disabled}
        onClick={() => onChange(Number(draft || 0) + step)}
      >
        +
      </button>
    </div>
  );
}

function SliderControl({ field, value, disabled, onChange }: FieldControlProps) {
  const number = typeof value === 'number' ? value : Number(value) || 0;
  const min = field.constraints.min ?? 0;
  const max = field.constraints.max ?? 100;
  const step = field.constraints.step ?? (field.constraints.integer ? 1 : 0.01);
  return (
    <div className="slider-wrap">
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={number}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        className="input number-input slider-number"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={number}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
}

/** Loaders with many entries (models, LoRA, VAE, CLIP) open a searchable picker. */
const LONG_LIST_INPUT =
  /ckpt|checkpoint|unet|lora|vae|clip|embedding|control.?net|ipadapter|upscale.*model|style.*model|model_name/i;

/** Sampler/scheduler lists are long but browsed by eye; keep the native picker. */
const SHORT_ENUM_INPUT = /sampler|scheduler/i;

function usesPicker(field: Field, count: number): boolean {
  if (SHORT_ENUM_INPUT.test(field.input)) return false;
  if (LONG_LIST_INPUT.test(field.input)) return count > 12;
  return count > 20;
}

function SelectControl({ field, value, disabled, onChange }: FieldControlProps) {
  const options = field.constraints.options ?? [];
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const current = value === undefined || value === null ? '' : String(value);
  const picker = usesPicker(field, options.length);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const openPicker = (): void => {
    setQuery('');
    setOpen(true);
  };

  if (picker) {
    return (
      <div className="select-wrap">
        <button
          type="button"
          className="input select picker-trigger"
          disabled={disabled}
          onClick={openPicker}
        >
          <span className={current ? undefined : 'picker-placeholder'}>
            {current || '（未选择）'}
          </span>
          <Icon name="chevron" size={18} />
        </button>
        {open
          ? createPortal(
              <div
                className="picker-overlay"
                role="dialog"
                aria-modal="true"
                onClick={() => setOpen(false)}
              >
                <div className="picker-sheet" onClick={(event) => event.stopPropagation()}>
                  <div className="picker-head">
                    <strong>{field.label}</strong>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={zh.common.close}
                      onClick={() => setOpen(false)}
                    >
                      <Icon name="close" size={20} />
                    </button>
                  </div>
                  <div className="search-field">
                    <Icon name="search" size={16} />
                    <input
                      autoFocus
                      value={query}
                      placeholder="搜索选项"
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  <div className="picker-list">
                    {filtered.length ? (
                      filtered.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`picker-option${option.value === current ? ' selected' : ''}`}
                          onClick={() => {
                            onChange(option.value);
                            setOpen(false);
                          }}
                        >
                          <span>{option.label}</span>
                          {option.value === current ? <Icon name="check" size={18} /> : null}
                        </button>
                      ))
                    ) : (
                      <p className="picker-empty">没有匹配的选项</p>
                    )}
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  }

  return (
    <div className="select-wrap">
      <select
        className="input select"
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {current && !options.some((option) => option.value === current) ? (
          <option value={current}>{current}（当前值）</option>
        ) : null}
        {!current && !field.required ? <option value="">（未选择）</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleControl({ value, disabled, onChange }: FieldControlProps) {
  const on = Boolean(value);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      className={`switch${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch-thumb" />
      <span className="switch-label">{on ? '开启' : '关闭'}</span>
    </button>
  );
}

function SeedControl({ field, value, disabled, onChange }: FieldControlProps) {
  return (
    <div className="seed-row">
      <NumberInput field={field} value={value} disabled={disabled} onChange={onChange} compact />
      <button
        type="button"
        className="icon-button bordered"
        title={zh.form.random}
        aria-label={zh.form.random}
        disabled={disabled}
        onClick={() => onChange(Math.floor(Math.random() * 2 ** 32))}
      >
        <Icon name="shuffle" size={20} />
      </button>
    </div>
  );
}

function ImageControl({ field, value, disabled, compact, project, onChange }: FieldControlProps) {
  const { showToast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const uploadDir = project ? `${project}/inputs` : 'inputs';

  const asset = isAssetRef(value) ? value : null;
  const text = asset ? asset.path : value === undefined || value === null ? '' : String(value);
  const name = asset ? asset.name ?? asset.path.split('/').pop() ?? asset.path : text.split('/').pop() ?? text;
  const preview = asset ? assetUrl(asset.path) : localPreview;

  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const clearPreview = (): void => {
    setLocalPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const pick = (): void => inputRef.current?.click();

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    clearPreview();
    const local = URL.createObjectURL(file);
    setLocalPreview(local);
    try {
      const { item } = await api.uploadAsset(file, uploadDir);
      clearPreview();
      onChange({ path: item.path, name: item.name, kind: item.kind });
      showToast(`已上传 ${item.name}`, 'success');
    } catch (error) {
      clearPreview();
      showToast(errorMessage(error), 'error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const chooseFromLibrary = (): void => setPickerOpen(true);

  if (compact) {
    return (
      <div className="image-compact">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          className="image-compact-main"
          disabled={disabled || uploading}
          onClick={chooseFromLibrary}
        >
          <Icon name="image" size={18} />
          <span className="image-compact-name">{text ? name : '未选择图片'}</span>
        </button>
        {uploading ? (
          <Spinner size={16} label={zh.form.uploading} />
        ) : (
          <button
            type="button"
            className="icon-button tiny"
            title="上传新图片"
            aria-label="上传新图片"
            disabled={disabled}
            onClick={pick}
          >
            <Icon name="upload" size={17} />
          </button>
        )}
        {text ? (
          <button
            type="button"
            className="text-button danger"
            disabled={disabled}
            onClick={() => {
              clearPreview();
              onChange('');
            }}
          >
            {zh.form.clear}
          </button>
        ) : null}
        <AssetPicker
          open={pickerOpen}
          title={`${field.label} · 素材库`}
          kinds={['image']}
          project={project}
          onClose={() => setPickerOpen(false)}
          onSelect={(item) => {
            onChange({ path: item.path, name: item.name, kind: item.kind });
            setPickerOpen(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="image-field">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <button
        type="button"
        className={`image-drop${preview ? ' has-preview' : ''}`}
        disabled={disabled || uploading}
        onClick={pick}
      >
        {preview ? (
          <img src={preview} alt="素材预览" />
        ) : (
          <span className="image-placeholder">
            <Icon name="image" size={28} />
            <span>{text ? name : zh.form.upload}</span>
            {text && !asset ? <small>ComfyUI 素材（{text.slice(0, 24)}…）</small> : null}
          </span>
        )}
        <span className="image-upload-badge">
          {uploading ? <Spinner size={16} label={zh.form.uploading} /> : <><Icon name="upload" size={16} /> {zh.form.upload}</>}
        </span>
      </button>
      {text ? (
        <div className="image-meta">
          <span title={text}>{name}</span>
        </div>
      ) : null}
      <div className="image-actions">
        <button
          type="button"
          className="text-button"
          disabled={disabled}
          onClick={chooseFromLibrary}
        >
          <Icon name="folder" size={16} /> 素材库
        </button>
        {text ? (
          <button
            type="button"
            className="text-button danger"
            disabled={disabled}
            onClick={() => {
              clearPreview();
              onChange('');
            }}
          >
            {zh.form.clear}
          </button>
        ) : null}
      </div>
      <AssetPicker
        open={pickerOpen}
        title={`${field.label} · 素材库`}
        kinds={['image']}
        project={project}
        onClose={() => setPickerOpen(false)}
        onSelect={(item) => {
          onChange({ path: item.path, name: item.name, kind: item.kind });
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

export function FieldControl(props: FieldControlProps) {
  const { field } = props;
  if (field.kind === 'textarea' || field.kind === 'text') return <StringInput {...props} />;
  if (field.kind === 'number') return <NumberInput {...props} />;
  if (field.kind === 'slider') return <SliderControl {...props} />;
  if (field.kind === 'select') return <SelectControl {...props} />;
  if (field.kind === 'toggle') return <ToggleControl {...props} />;
  if (field.kind === 'seed') return <SeedControl {...props} />;
  if (field.kind === 'image') return <ImageControl {...props} />;
  return <StringInput {...props} />;
}

export interface FieldNotice {
  level: 'warn' | 'danger';
  message: string;
}

export function FieldRow({
  field,
  error,
  warning,
  skipped,
  onToggleSkip,
  hideNodeTitle,
  children,
}: {
  field: Field;
  error?: string;
  /** Conversion warning (missing resource, replaced option, ...) for this field. */
  warning?: FieldNotice;
  /** Reference-image slot cancelled by the user. */
  skipped?: boolean;
  onToggleSkip?: () => void;
  /** The card header already names the node (模型加载 cards). */
  hideNodeTitle?: boolean;
  children: ReactNode;
}) {
  const warningTone = !error && warning ? warning.level : undefined;
  return (
    <div
      className={`field${error ? ' has-error' : ''}${warningTone ? ` has-warning tone-${warningTone}` : ''}${
        skipped ? ' is-skipped' : ''
      }`}
      data-field-key={field.key}
    >
      <div className="field-head">
        <label className="field-label">
          {field.label}
          {field.required && !skipped ? <span className="required-dot" title={zh.form.required}>*</span> : null}
        </label>
        <span className="field-head-actions">
          {onToggleSkip ? (
            <button
              type="button"
              className={`text-button field-skip${skipped ? ' restore' : ''}`}
              title={
                skipped
                  ? '恢复这个素材槽位，让加载节点重新参与运行'
                  : '绕过这个素材槽位（等同于 ComfyUI 的 Ctrl+B），不必上传文件'
              }
              onClick={onToggleSkip}
            >
              {skipped ? '恢复槽位' : '取消槽位'}
            </button>
          ) : null}
        </span>
      </div>
      {field.nodeTitle && !hideNodeTitle ? <p className="field-node-title">{field.nodeTitle}</p> : null}
      {field.description && field.kind !== 'textarea' ? (
        <p className="field-desc">{field.description}</p>
      ) : null}
      {skipped ? (
        <div className="field-skipped">
          <Icon name="check" size={16} />
          <span>该槽位已绕过，运行时不会使用它，也无需上传文件。</span>
        </div>
      ) : (
        children
      )}
      {error ? (
        <p className="field-error">{error}</p>
      ) : warning ? (
        <p className={`field-warning ${warning.level}`}>
          <Icon name="alert" size={14} />
          <span>{warning.message}</span>
        </p>
      ) : null}
    </div>
  );
}
