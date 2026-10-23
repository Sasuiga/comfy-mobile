import { useNavigate } from 'react-router-dom';
import type { AppConfigPublic } from '@comfy-mobile/shared';
import { useApp } from '../context';
import { ConnectionForm } from '../components/ConnectionForm';
import { Icon } from '../components/Icon';
import { usePageTitle } from '../components/UI';
import { zh } from '../i18n';

export function SetupPage() {
  usePageTitle(zh.settings.setupTitle);
  const navigate = useNavigate();
  const { config, refreshConfig, showToast } = useApp();

  if (!config) return null;

  const onSaved = (saved: AppConfigPublic): void => {
    if (saved.setupRequired) return;
    showToast(zh.settings.saved, 'success');
    void refreshConfig();
    navigate('/', { replace: true });
  };

  return (
    <div className="setup-page">
      <div className="setup-hero">
        <span className="boot-mark">
          <Icon name="spark" size={32} />
        </span>
        <h1>{zh.settings.setupTitle}</h1>
        <p>{zh.settings.setupHint}</p>
      </div>
      <div className="setup-card">
        <ConnectionForm
          config={config}
          submitLabel={zh.settings.start}
          onSaved={onSaved}
          autoFocus
        />
      </div>
      <p className="setup-footnote">
        地址需要能被这个服务访问到。若两个应用运行在不同容器中，请先在平台里做好端口转发。
      </p>
    </div>
  );
}
