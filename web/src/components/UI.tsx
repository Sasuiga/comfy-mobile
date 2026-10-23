import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { RunState } from '@comfy-mobile/shared';
import { useApp } from '../context';
import { zh } from '../i18n';
import { Icon, type IconName } from './Icon';

export function Spinner({ size = 20, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" style={{ width: size, height: size }} />
      {label ? <span className="spinner-label">{label}</span> : null}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  large,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: string | boolean;
  actions?: ReactNode;
  large?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <header className={`page-header${large ? ' page-header-large' : ''}`}>
      <div className="page-header-row">
        {back ? (
          <button
            type="button"
            className="icon-button"
            aria-label={zh.common.back}
            onClick={() => (typeof back === 'string' ? navigate(back) : navigate(-1))}
          >
            <Icon name="back" />
          </button>
        ) : (
          <span className="header-spacer" />
        )}
        <div className="page-title-wrap">
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="header-actions">{actions}</div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const location = useLocation();
  const items: Array<{ to: string; label: string; icon: IconName; match: (path: string) => boolean }> = [
    {
      to: '/',
      label: zh.nav.projects,
      icon: 'folder',
      match: (path) =>
        path === '/' ||
        path.startsWith('/p/') ||
        path.startsWith('/generate') ||
        path.startsWith('/templates') ||
        path.startsWith('/assets'),
    },
    {
      to: '/history',
      label: zh.nav.history,
      icon: 'history',
      match: (path) => path.startsWith('/history') || path.startsWith('/runs/'),
    },
    {
      to: '/settings',
      label: zh.nav.settings,
      icon: 'settings',
      match: (path) => path.startsWith('/settings') || path.startsWith('/setup'),
    },
  ];
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {items.map((item) => {
        const active = item.match(location.pathname);
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`bottom-nav-item${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon name={item.icon} size={22} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const STATE_LABELS: Record<RunState, string> = {
  queued: zh.status.queued,
  running: zh.status.running,
  completed: zh.status.completed,
  failed: zh.status.failed,
  canceled: zh.status.canceled,
};

export function StatusBadge({ state }: { state: RunState }) {
  return <span className={`badge badge-${state}`}>{STATE_LABELS[state]}</span>;
}

export function EmptyState({
  icon = 'spark',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={30} />
      </span>
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBox({
  message,
  details,
  onRetry,
}: {
  message: string;
  details?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <Icon name="alert" size={20} />
      <div>
        <strong>{message}</strong>
        {details ? <div className="error-details">{details}</div> : null}
        {onRetry ? (
          <button type="button" className="text-button" onClick={onRetry}>
            {zh.common.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label={zh.common.close} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ToastHost() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <button
          type="button"
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}

export function SectionCard({
  title,
  description,
  children,
  actions,
  tone,
  badge,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Highlights the whole card when it contains a field that needs attention. */
  tone?: 'warn' | 'danger';
  badge?: ReactNode;
}) {
  return (
    <section className={`section-card${tone ? ` tone-${tone}` : ''}`}>
      {title || actions ? (
        <div className="section-card-header">
          <div>
            <div className="section-card-title">
              {title ? <h2>{title}</h2> : null}
              {badge ? <span className={`section-card-badge ${tone ?? 'warn'}`}>{badge}</span> : null}
            </div>
            {description ? <p>{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${zh.appName}`;
  }, [title]);
}
