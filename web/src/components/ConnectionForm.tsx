import { useState } from 'react';
import type {
  AppConfigPublic,
  ConnectionTestResult,
  UpdateConfigRequest,
} from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon } from './Icon';
import { Spinner } from './UI';

function parseHeaders(text: string): Record<string, string> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求头必须是 JSON 对象');
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`请求头 ${key} 的值必须是字符串`);
    headers[key] = value;
  }
  return headers;
}

export function ConnectionForm({
  config,
  submitLabel,
  onSaved,
  autoFocus = false,
}: {
  config: AppConfigPublic;
  submitLabel?: string;
  onSaved: (config: AppConfigPublic) => void;
  autoFocus?: boolean;
}) {
  const { showToast } = useApp();
  const [url, setUrl] = useState(config.comfyUrl);
  const [token, setToken] = useState('');
  const [headersText, setHeadersText] = useState('');
  const [insecure, setInsecure] = useState(false);
  const [clearToken, setClearToken] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildBody = (): UpdateConfigRequest => {
    let headers: Record<string, string> | null | undefined;
    if (clearHeaders) headers = null;
    else headers = parseHeaders(headersText);
    return {
      comfyUrl: config.locked.comfyUrl ? undefined : url.trim(),
      token: config.locked.token ? undefined : clearToken ? null : token.trim() || undefined,
      headers,
      insecure,
    };
  };

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setError(null);
    try {
      const body = buildBody();
      const result = await api.testConnection(body);
      setTest(result);
      if (result.ok) showToast(`连接成功，延迟 ${result.latencyMs} ms`, 'success');
      else showToast(result.error || '连接失败', 'error');
    } catch (cause) {
      setTest(null);
      setError(errorMessage(cause));
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const body = buildBody();
      const response = await api.saveConfig(body);
      setTest(response.test);
      setToken('');
      setClearToken(false);
      showToast(zh.settings.saved, 'success');
      onSaved(response.config);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="connection-form">
      <div className="field">
        <div className="field-head">
          <label className="field-label" htmlFor="comfy-url">{zh.settings.comfyUrl}</label>
          {config.locked.comfyUrl ? <span className="lock-note">{zh.settings.lockedUrl}</span> : null}
        </div>
        <input
          id="comfy-url"
          className="input"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder="http://192.168.1.100:8188"
          value={url}
          disabled={config.locked.comfyUrl || saving}
          onChange={(event) => setUrl(event.target.value)}
        />
        <p className="field-desc">{zh.settings.comfyUrlHint}</p>
      </div>

      <div className="field">
        <div className="field-head">
          <label className="field-label" htmlFor="comfy-token">{zh.settings.token}</label>
          {config.locked.token ? <span className="lock-note">{zh.settings.lockedToken}</span> : null}
        </div>
        <input
          id="comfy-token"
          className="input"
          type="password"
          autoComplete="off"
          placeholder={config.hasToken ? zh.settings.canKeepToken : zh.settings.tokenPlaceholder}
          value={token}
          disabled={config.locked.token || saving || clearToken}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="field-desc">{config.hasToken ? zh.settings.hasToken : zh.settings.tokenHint}</p>
        {config.hasToken && !config.locked.token ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={clearToken}
              onChange={(event) => setClearToken(event.target.checked)}
            />
            {zh.settings.clearToken}
          </label>
        ) : null}
      </div>

      <details className="advanced-details">
        <summary>{zh.settings.headers}</summary>
        <div className="field">
          <textarea
            className="input textarea mono"
            rows={3}
            spellCheck={false}
            placeholder={'{\n  "X-API-Key": "…"\n}'}
            value={headersText}
            disabled={saving || clearHeaders}
            onChange={(event) => setHeadersText(event.target.value)}
          />
          <p className="field-desc">{zh.settings.headersHint}</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={clearHeaders}
              onChange={(event) => setClearHeaders(event.target.checked)}
            />
            {zh.settings.clearHeaders}
          </label>
        </div>
      </details>

      <label className="switch-row">
        <span>
          <strong>{zh.settings.insecure}</strong>
          <small>{zh.settings.insecureHint}</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={insecure}
          className={`switch${insecure ? ' on' : ''}`}
          onClick={() => setInsecure((value) => !value)}
        >
          <span className="switch-thumb" />
        </button>
      </label>

      {error ? (
        <div className="error-box" role="alert">
          <Icon name="alert" size={20} />
          <div><strong>{error}</strong></div>
        </div>
      ) : null}

      {test ? (
        <div className={`test-result${test.ok ? ' ok' : ' bad'}`}>
          <div className="test-result-head">
            <Icon name={test.ok ? 'check' : 'alert'} size={18} />
            <strong>{test.ok ? '连接成功' : '连接失败'}</strong>
            <span>{test.latencyMs} ms</span>
          </div>
          {test.ok ? (
            <div className="test-meta">
              {test.comfyVersion ? <span>ComfyUI {test.comfyVersion}</span> : null}
              {test.workflowCount !== undefined ? (
                <span>{test.workflowCount} {zh.settings.workflowsFound}</span>
              ) : null}
            </div>
          ) : (
            <p>{test.error}</p>
          )}
          {test.warning ? <p className="warn-text">{test.warning}</p> : null}
        </div>
      ) : null}

      <div className="form-actions">
        <button type="button" className="button secondary" disabled={testing || saving} onClick={() => void runTest()}>
          {testing ? <Spinner size={18} label={zh.settings.testing} /> : <><Icon name="link" size={18} /> {zh.settings.test}</>}
        </button>
        <button type="button" className="button primary" disabled={saving || testing || !url.trim()} onClick={() => void save()}>
          {saving ? <Spinner size={18} label={zh.settings.saving} /> : (submitLabel ?? zh.settings.save)}
        </button>
      </div>
    </div>
  );
}
