import { useRef, useState } from 'react';
import type { AssetRef, Field } from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon } from './Icon';
import { Spinner } from './UI';

interface MultiImageUploadProps {
  /** Image fields in display order; the first N uploads fill the first N slots. */
  fields: Field[];
  values: Record<string, unknown>;
  disabled?: boolean;
  /** Project whose inputs/ directory receives the uploads. */
  project?: string;
  onApply: (assignments: { key: string; value: unknown }[]) => void;
}

/**
 * Batch upload for workflows with several reference-image slots. Selecting
 * three files fills the first three LoadImage nodes, leaving the rest empty.
 */
export function MultiImageUpload({
  fields,
  values,
  disabled,
  project,
  onApply,
}: MultiImageUploadProps) {
  const { showToast } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const uploadDir = project ? `${project}/inputs` : 'inputs';

  const filled = fields.filter((field) => Boolean(values[field.key])).length;

  const pick = (): void => inputRef.current?.click();

  const upload = async (files: File[]): Promise<void> => {
    const usable = files.slice(0, fields.length);
    if (!usable.length) return;
    setUploading(true);
    setProgress({ done: 0, total: usable.length });
    const assignments: { key: string; value: unknown }[] = [];
    try {
      for (let index = 0; index < usable.length; index += 1) {
        const { item } = await api.uploadAsset(usable[index]!, uploadDir);
        const asset: AssetRef = { path: item.path, name: item.name, kind: item.kind };
        assignments.push({ key: fields[index]!.key, value: asset });
        setProgress({ done: index + 1, total: usable.length });
      }
    } catch (error) {
      showToast(errorMessage(error), 'error');
    } finally {
      if (assignments.length) {
        onApply(assignments);
        showToast(`已填入 ${assignments.length} 张图片`, 'success');
      }
      if (files.length > fields.length) {
        showToast(
          `工作流只有 ${fields.length} 个图片槽位，多出的 ${files.length - fields.length} 张未使用`,
          'error',
        );
      }
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="multi-image">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) void upload(files);
        }}
      />
      <button
        type="button"
        className="button secondary multi-image-button"
        disabled={disabled || uploading}
        onClick={pick}
      >
        {uploading ? (
          <Spinner size={16} label={zh.form.uploading} />
        ) : (
          <Icon name="image" size={18} />
        )}
        <span>
          {uploading
            ? `上传中 ${progress.done}/${progress.total}`
            : '批量上传图片'}
        </span>
        <span className="multi-image-count">
          {filled}/{fields.length}
        </span>
      </button>
      <p className="multi-image-hint">
        可一次选择多张，按顺序填入下方 {fields.length} 个启用中的图片槽位；已取消或未选到的槽位保持不变。
      </p>
    </div>
  );
}
