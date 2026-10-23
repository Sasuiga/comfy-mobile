import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './context';
import { zh } from './i18n';
import { BottomNav, Spinner, ToastHost } from './components/UI';
import { Icon } from './components/Icon';
import { AssetsPage } from './pages/AssetsPage';
import { FormEditorPage } from './pages/FormEditorPage';
import { GeneratePage } from './pages/GeneratePage';
import { HistoryPage } from './pages/HistoryPage';
import { LoginPage } from './pages/LoginPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunPage } from './pages/RunPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { WorkflowFormPage } from './pages/WorkflowFormPage';

function ScrollToTop(): null {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [pathname]);
  return null;
}

function BootSplash({ message }: { message: string }) {
  return (
    <div className="boot-screen">
      <span className="boot-mark">
        <Icon name="spark" size={34} />
      </span>
      <Spinner size={24} label={message} />
    </div>
  );
}

function BootError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="boot-screen">
      <span className="boot-mark error">
        <Icon name="alert" size={32} />
      </span>
      <h1>无法连接服务</h1>
      <p>请检查服务是否正在运行，然后重试。</p>
      <button type="button" className="button primary" onClick={onRetry}>
        {zh.common.retry}
      </button>
    </div>
  );
}

function NavGate() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/w/') || pathname.startsWith('/setup') || pathname.startsWith('/login')) {
    return null;
  }
  return <BottomNav />;
}

function AppFrame() {
  const { config, loadingConfig, authRequired, refreshConfig } = useApp();

  let content;
  if (authRequired) {
    content = <LoginPage />;
  } else if (loadingConfig && !config) {
    content = <BootSplash message={zh.common.loading} />;
  } else if (!config) {
    content = <BootError onRetry={() => void refreshConfig()} />;
  } else if (config.setupRequired) {
    content = <SetupPage />;
  } else {
    content = (
      <div className="app-shell">
        <ScrollToTop />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/p/:project" element={<ProjectPage />} />
            <Route path="/generate" element={<GeneratePage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/assets" element={<AssetsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/w/:key" element={<WorkflowFormPage />} />
            <Route path="/w/:key/edit" element={<FormEditorPage />} />
            <Route path="/runs/:id" element={<RunPage />} />
            <Route path="/setup" element={<Navigate to="/" replace />} />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <NavGate />
      </div>
    );
  }

  return (
    <>
      {content}
      <ToastHost />
    </>
  );
}

export function App() {
  return (
    <HashRouter>
      <AppProvider>
        <AppFrame />
      </AppProvider>
    </HashRouter>
  );
}
