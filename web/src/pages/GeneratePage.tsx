import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_PROJECT,
  projectDisplayTitle,
  type ProjectSummary,
} from '@comfy-mobile/shared';
import { api, errorMessage } from '../api';
import { Icon } from '../components/Icon';
import { WorkflowPicker } from '../components/WorkflowPicker';
import {
  ErrorBox,
  PageHeader,
  SectionCard,
  Spinner,
  usePageTitle,
} from '../components/UI';

const LAST_PROJECT_KEY = 'comfy-mobile.last-project';

function readLastProject(): string {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeLastProject(project: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, project);
  } catch {
    // ignore
  }
}

export function GeneratePage() {
  usePageTitle('生成');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState(
    () => params.get('project')?.trim() || readLastProject() || DEFAULT_PROJECT,
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listProjects();
      setProjects(response.items);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Fall back to the default project when the requested one no longer exists.
  useEffect(() => {
    if (!projects.length) return;
    if (projects.some((item) => item.path === project)) {
      storeLastProject(project);
      return;
    }
    const fallback =
      projects.find((item) => item.path === DEFAULT_PROJECT)?.path ?? projects[0]!.path;
    setProject(fallback);
    storeLastProject(fallback);
    setParams({ project: fallback }, { replace: true });
  }, [projects, project, setParams]);

  const chooseProject = (next: string): void => {
    setProject(next);
    storeLastProject(next);
    setParams({ project: next }, { replace: true });
  };

  const projectHref = `/p/${encodeURIComponent(project)}`;

  return (
    <div className="page generate-page">
      <PageHeader
        title="生成"
        back={projectHref}
        subtitle={<span className="project-tag">{projectDisplayTitle(project)}</span>}
      />

      {error ? <ErrorBox message={error} onRetry={() => void load()} /> : null}

      {loading ? (
        <div className="loading-block">
          <Spinner size={26} label="加载项目中…" />
        </div>
      ) : (
        <>
          <SectionCard
            title="当前项目"
            description="输入素材和生成结果都会归入这个项目。"
          >
            <select
              className="input select"
              value={project}
              aria-label="选择项目"
              onChange={(event) => chooseProject(event.target.value)}
            >
              {projects.length ? null : (
                <option value={project}>{projectDisplayTitle(project)}</option>
              )}
              {projects.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.title}
                  {item.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </SectionCard>

          <button
            type="button"
            className="generate-start"
            disabled={!project}
            onClick={() => setPickerOpen(true)}
          >
            <span className="generate-start-icon" aria-hidden="true">
              <Icon name="spark" size={24} />
            </span>
            <span className="generate-start-main">
              <strong>选择工作流</strong>
              <span>已保存的工作流、官方模板或导入 JSON</span>
            </span>
            <Icon name="chevron" size={18} className="chevron" />
          </button>

          <p className="muted-note">
            工作流只是生产工具，不会显示在首页。运行完成后，结果会自动归档到当前项目的「输出」。
          </p>
        </>
      )}

      <WorkflowPicker
        open={pickerOpen}
        project={project}
        onClose={() => setPickerOpen(false)}
        onSelect={(key) =>
          navigate(`/w/${encodeURIComponent(key)}?project=${encodeURIComponent(project)}`)
        }
      />
    </div>
  );
}
