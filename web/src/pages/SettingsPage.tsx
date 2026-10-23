import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssetStorageInfo, ComfyCapabilities } from '@comfy-mobile/shared';
import { api, errorMessage, getToken } from '../api';
import { useApp } from '../context';
import { ConnectionForm } from '../components/ConnectionForm';
import { Icon } from '../components/Icon';
import { WorkspacePicker } from '../components/WorkspacePicker';
import {
  PageHeader,
  SectionCard,
  Spinner,
  usePageTitle,
} from '../components/UI';
import { zh } from '../i18n';

const CAPABILITY_LABELS: Array<[keyof ComfyCapabilities, string]> = [
  ['userdata', '工作流列表'],
  ['prompt', '提交任务'],
  ['websocket', '实时进度'],
  ['historyV2', '新版历史接口'],
  ['jobs', '任务取消'],
  ['uploadAssetHash', '资源哈希上传'],
  ['systemStats', '系统信息'],
];

export function SettingsPage() {
  usePageTitle(zh.settings.title);
  const { config, refreshConfig, login, logout, showToast } = useApp();
  const [version, setVersion] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);
  const [localToken, setLocalToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const hasLocalToken = Boolean(getToken());
  const [assetInfo, setAssetInfo] = useState<AssetStorageInfo | null>(null);
  const [assetLoading, setAssetLoading] = useState(true);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [workspacePicker, setWorkspacePicker] = useState(false);
  const [resettingWorkspace, setResettingWorkspace] = useState(false);

  useEffect(() => {
    void api
      .version()
      .then((response) => setVersion(response.version))
      .catch(() => undefined);
  }, []);

  const loadAssetInfo = async (): Promise<void> => {
    setAssetLoading(true);
    setAssetError(null);
    try {
      setAssetInfo(await api.assetInfo());
    } catch (cause) {
      setAssetError(errorMessage(cause));
    } finally {
      setAssetLoading(false);
    }
  };

  useEffect(() => {
    void loadAssetInfo();
  }, []);

  const resetWorkspace = async (): Promise<void> => {
    setResettingWorkspace(true);
    try {
      const next = await api.selectAssetWorkspace('ComfyMobile');
      setAssetInfo(next);
      showToast('已恢复默认项目根目录', 'success');
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setResettingWorkspace(false);
    }
  };

  if (!config) {
    return (
      <div className="page">
        <PageHeader title={zh.settings.title} />
        <div className="loading-block"><Spinner size={26} label={zh.common.loading} /></div>
      </div>
    );
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const result = await api.refreshCaches();
      await refreshConfig();
      showToast(
        result.workflowCount !== undefined
          ? `${zh.settings.refreshed} · ${result.workflowCount} 个工作流`
          : zh.settings.refreshed,
        'success',
      );
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const saveToken = async (): Promise<void> => {
    const value = localToken.trim();
    if (!value) {
      setLocalToken('');
      return;
    }
    setSavingToken(true);
    const ok = await login(value);
    setSavingToken(false);
    if (ok) {
      setLocalToken('');
      showToast('访问令牌已保存', 'success');
    } else {
      showToast(zh.login.failed, 'error');
    }
  };

  return (
    <div className="page">
      <PageHeader
        large
        title={zh.settings.title}
        subtitle={
          <span className={`connection-line${config.connected ? ' ok' : ' bad'}`}>
            <span className="status-dot" />
            {config.connected ? zh.status.connected : zh.status.disconnected}
            {config.comfyVersion ? ` · ComfyUI ${config.comfyVersion}` : ''}
          </span>
        }
      />

      <SectionCard
        title={zh.settings.connection}
        description={`ComfyUI: ${config.comfyUrl || '未配置'}`}
      >
        <ConnectionForm
          config={config}
          onSaved={() => {
            void refreshConfig();
          }}
        />
      </SectionCard>

      <SectionCard
        title="项目存储"
        description="项目、输入素材与运行结果的保存位置。"
      >
        {assetLoading ? (
          <div className="loading-block"><Spinner size={22} label={zh.common.loading} /></div>
        ) : assetError ? (
          <div className="asset-warning" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <strong>无法读取项目存储设置</strong>
              <p>{assetError}</p>
              <button type="button" className="text-button" onClick={() => void loadAssetInfo()}>
                {zh.common.retry}
              </button>
            </div>
          </div>
        ) : assetInfo ? (
          <>
            {assetInfo.fallback ? (
              <div className="asset-warning" role="alert">
                <Icon name="alert" size={18} />
                <div>
                  <strong>正在使用应用本地目录</strong>
                  <p>{assetInfo.warning ?? '配置的项目根目录不可用，项目会保存到服务数据目录。'}</p>
                </div>
              </div>
            ) : null}
            <dl className="asset-storage-list">
              <div>
                <dt>当前项目根目录</dt>
                <dd>{assetInfo.workspace}</dd>
              </div>
              <div>
                <dt>完整路径</dt>
                <dd className="mono">{assetInfo.workspacePath}</dd>
              </div>
              <div>
                <dt>可选根目录</dt>
                <dd className="mono">{assetInfo.browseRoot}</dd>
              </div>
            </dl>
            <div className="inline-row">
              <button
                type="button"
                className="button secondary"
                disabled={Boolean(assetInfo.fallback)}
                onClick={() => setWorkspacePicker(true)}
              >
                <Icon name="folder" size={18} />
                更换根目录
              </button>
              {assetInfo.workspace !== 'ComfyMobile' && !assetInfo.fallback ? (
                <button
                  type="button"
                  className="button ghost"
                  disabled={resettingWorkspace}
                  onClick={() => void resetWorkspace()}
                >
                  {resettingWorkspace ? <Spinner size={16} /> : '恢复默认'}
                </button>
              ) : null}
            </div>
            <p className="field-desc">
              每个项目是根目录下的一个文件夹，内含 inputs/ 与 outputs/。
              运行输出会自动归档到所属项目。删除项目或素材会直接移除文件，无法恢复。
            </p>
            <Link className="text-button" to="/assets">
              浏览全部素材（排查用）
            </Link>
          </>
        ) : null}
      </SectionCard>

      <SectionCard title={zh.settings.caches}>
        <button
          type="button"
          className="button secondary block"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? (
            <Spinner size={18} label="刷新中…" />
          ) : (
            <>
              <Icon name="refresh" size={18} />
              {zh.settings.refreshCaches}
            </>
          )}
        </button>
        <p className="field-desc">
          修改 ComfyUI 工作流或安装新节点后，用这里重新读取列表与节点信息。
        </p>
      </SectionCard>

      {config.capabilities ? (
        <SectionCard title={zh.settings.capability}>
          <div className="capability-grid">
            {CAPABILITY_LABELS.map(([key, label]) => (
              <span
                key={key}
                className={`capability-chip${config.capabilities?.[key] ? ' on' : ''}`}
              >
                <Icon name={config.capabilities?.[key] ? 'check' : 'close'} size={14} />
                {label}
              </span>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title={zh.settings.access} description={zh.settings.accessHint}>
        <div className="field">
          <div className="field-head">
            <span className="field-label">
              {hasLocalToken ? '已保存本机访问令牌' : zh.settings.access}
            </span>
          </div>
          <div className="inline-row">
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder={hasLocalToken ? '输入新令牌以替换' : zh.login.placeholder}
              value={localToken}
              onChange={(event) => setLocalToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveToken();
              }}
            />
            <button
              type="button"
              className="button secondary"
              disabled={savingToken || !localToken.trim()}
              onClick={() => void saveToken()}
            >
              {savingToken ? <Spinner size={18} /> : zh.common.save}
            </button>
          </div>
        </div>
        {hasLocalToken ? (
          <button type="button" className="text-button danger" onClick={logout}>
            {zh.settings.logout}
          </button>
        ) : null}
      </SectionCard>

      <SectionCard title={zh.settings.about}>
        <dl className="about-list">
          <div>
            <dt>{zh.settings.version}</dt>
            <dd>{version || '—'}</dd>
          </div>
          <div>
            <dt>{zh.settings.latency}</dt>
            <dd>{config.connected ? '在线' : '离线'}</dd>
          </div>
          <div>
            <dt>上传上限</dt>
            <dd>{config.maxUploadMb} MB</dd>
          </div>
        </dl>
        <p className="field-desc">
          {zh.appName} · 运行在独立服务上，ComfyUI 凭据只保存在服务端。
        </p>
        <Link className="text-button" to="/">
          返回项目列表
        </Link>
      </SectionCard>

      {assetInfo ? (
        <WorkspacePicker
          open={workspacePicker}
          info={assetInfo}
          onClose={() => setWorkspacePicker(false)}
          onSelected={setAssetInfo}
        />
      ) : null}
    </div>
  );
}
