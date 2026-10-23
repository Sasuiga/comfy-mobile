import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Field } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon } from './Icon';
import { Spinner } from './UI';

export interface FieldControlProps {
  field: Field;
  value: unknown;
  error?: string;
  disabled?: boolean;
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
      <textarea
        className="input textarea"
        value={text}
        rows={text.length > 0 ? rows : 4}
        maxLength={field.constraints.maxLength}
        placeholder={field.description || '输入内容'}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
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

function SelectControl({ field, value, disabled, onChange }: FieldControlProps) {
  const options = field.constraints.options ?? [];
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q),
    );
  }, [options, query]);
  const current = value === undefined || value === null ? '' : String(value);
  return (
    <div className="select-wrap">
      {options.length > 16 ? (
        <div className="search-field small">
          <Icon name="search" size={16} />
          <input
            value={query}
            placeholder="筛选选项"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      ) : null}
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
        {filtered.map((option) => (
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

function ImageControl({ value, disabled, onChange }: FieldControlProps) {
  const { showToast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const text = value === undefined || value === null ? '' : String(value);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const pick = (): void => inputRef.current?.click();

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    try {
      const result = await api.upload(file);
      const valueToUse = result.assetHash || (result.subfolder ? `${result.subfolder}/${result.name}` : result.name);
      onChange(valueToUse);
      showToast(`已上传 ${result.name}`, 'success');
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

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
          <img src={preview} alt="上传预览" />
        ) : (
          <span className="image-placeholder">
            <Icon name="image" size={28} />
            <span>{text ? text.split('/').pop() : zh.form.upload}</span>
            {text.startsWith('blake3:') ? <small>ComfyUI 资产（{text.slice(0, 16)}…）</small> : null}
          </span>
        )}
        <span className="image-upload-badge">
          {uploading ? <Spinner size={16} label={zh.form.uploading} /> : <><Icon name="upload" size={16} /> {zh.form.upload}</>}
        </span>
      </button>
      {text ? (
        <div className="image-meta">
          <span title={text}>{text.length > 64 ? `${text.slice(0, 64)}…` : text}</span>
          <button type="button" className="text-button danger" onClick={() => { setPreview(null); onChange(''); }}>
            {zh.form.clear}
          </button>
        </div>
      ) : null}
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

export function FieldRow({ field, error, children }: { field: Field; error?: string; children: ReactNode }) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <div className="field-head">
        <label className="field-label">
          {field.label}
          {field.required ? <span className="required-dot" title={zh.form.required}>*</span> : null}
        </label>
        <span className="field-kind">{zh.field[field.kind]}</span>
      </div>
      {field.description && field.kind !== 'textarea' ? (
        <p className="field-desc">{field.description}</p>
      ) : null}
      {children}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}
