import { useState } from 'react';
import { useApp } from '../context';
import { usePageTitle } from '../components/UI';
import { Icon } from '../components/Icon';
import { zh } from '../i18n';

export function LoginPage() {
  usePageTitle(zh.login.title);
  const { login } = useApp();
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  const submit = async (): Promise<void> => {
    const value = token.trim();
    if (!value) {
      setError(true);
      return;
    }
    setSubmitting(true);
    setError(false);
    const ok = await login(value);
    setSubmitting(false);
    if (!ok) {
      setError(true);
      setToken('');
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <span className="boot-mark">
          <Icon name="spark" size={32} />
        </span>
        <h1>{zh.login.title}</h1>
        <p className="auth-hint">{zh.login.hint}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span className="field-label">{zh.settings.access}</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={token}
              placeholder={zh.login.placeholder}
              onChange={(event) => {
                setToken(event.target.value);
                setError(false);
              }}
            />
          </label>
          {error ? <p className="field-error" role="alert">{zh.login.failed}</p> : null}
          <button
            type="submit"
            className="button primary block"
            disabled={submitting || !token.trim()}
          >
            {submitting ? '验证中…' : zh.login.submit}
          </button>
        </form>
        <p className="auth-footnote">{zh.appName}</p>
      </div>
    </div>
  );
}
