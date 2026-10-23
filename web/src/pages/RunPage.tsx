import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { RunOutput, RunRecord, RunState } from '@comfy-mobile/shared';
import { api, errorMessage, outputUrl } from '../api';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import {
  ErrorBox,
  Modal,
  PageHeader,
  Spinner,
  StatusBadge,
  usePageTitle,
} from '../components/UI';
import { zh } from '../i18n';

const TERMINAL = new Set<RunState>(['completed', 'failed', 'canceled']);

function elapsedText(run: RunRecord, now: number): string {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  if (!Number.isFinite(start) || end < start) return '—';
  const total = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function errorLines(run: RunRecord): string[] {
  const details = run.error?.details as
    | { nodeErrors?: Array<{ message?: string; nodeId?: string }> }
    | undefined;
  if (!details || !Array.isArray(details.nodeErrors)) return [];
  return details.nodeErrors
    .map((item) => item.message)
    .filter((message): message is string => Boolean(message));
}

function downloadName(output: RunOutput): string {
  return output.filename.split(/[\\/]/).pop() || output.filename;
}

export function RunPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useApp();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [rerun, setRerun] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const runRef = useRef<RunRecord | null>(null);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(() => {
    setRun(null);
    runRef.current = null;
    setLoading(true);
    setLoadError(null);
    setViewer(null);

    let cancelled = false;
    let source: EventSource | null = null;
    let timer: number | undefined;
    let polling = false;

    const apply = (next: RunRecord): void => {
      if (cancelled) return;
      setRun(next);
      setLoading(false);
      if (TERMINAL.has(next.state)) {
        source?.close();
        source = null;
        if (timer) window.clearTimeout(timer);
      }
    };

    const poll = async (): Promise<void> => {
      if (cancelled) return;
      polling = true;
      try {
        const next = await api.getRun(id);
        apply(next);
        if (!cancelled && !TERMINAL.has(next.state)) {
          timer = window.setTimeout(() => void poll(), 2000);
        }
      } catch (cause) {
        if (!cancelled && !runRef.current) {
          setLoadError(errorMessage(cause));
          setLoading(false);
        }
        if (!cancelled && !TERMINAL.has(runRef.current?.state ?? 'queued')) {
          timer = window.setTimeout(() => void poll(), 3000);
        }
      } finally {
        polling = false;
      }
    };

    try {
      source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
      source.addEventListener('snapshot', (event) => {
        apply(JSON.parse((event as MessageEvent<string>).data) as RunRecord);
      });
      source.addEventListener('update', (event) => {
        apply(JSON.parse((event as MessageEvent<string>).data) as RunRecord);
      });
      source.addEventListener('done', (event) => {
        apply(JSON.parse((event as MessageEvent<string>).data) as RunRecord);
        source?.close();
        source = null;
      });
      source.onerror = () => {
        source?.close();
        source = null;
        if (!cancelled && !polling && !TERMINAL.has(runRef.current?.state ?? 'queued')) {
          void poll();
        }
      };
    } catch {
      void poll();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (timer) window.clearTimeout(timer);
    };
  }, [id]);

  const active = run ? !TERMINAL.has(run.state) : false;

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  usePageTitle(run ? run.workflowName : zh.run.title);

  const cancel = useCallback(async (): Promise<void> => {
    if (!run) return;
    if (!window.confirm(`${zh.run.cancel}？\n${zh.run.cancelHint}`)) return;
    setCanceling(true);
    try {
      const next = await api.cancelRun(run.id);
      setRun(next);
      showToast('已请求取消任务', 'info');
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setCanceling(false);
    }
  }, [run, showToast]);

  const submitAgain = async (): Promise<void> => {
    if (!run) return;
    setRerun(true);
    try {
      const response = await api.submitRun({
        workflowKey: run.workflowKey,
        values: run.values,
        randomizeSeeds: true,
      });
      navigate(`/runs/${response.runId}`);
    } catch (cause) {
      showToast(errorMessage(cause), 'error');
    } finally {
      setRerun(false);
    }
  };

  const reuse = (): void => {
    if (!run) return;
    navigate(`/w/${encodeURIComponent(run.workflowKey)}`, {
      state: { values: run.values },
    });
  };

  if (loading && !run) {
    return (
      <div className="page">
        <PageHeader title={zh.run.title} back="/history" />
        <div className="loading-block"><Spinner size={28} label={zh.common.loading} /></div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="page">
        <PageHeader title={zh.run.title} back="/history" />
        <ErrorBox message={loadError ?? '运行记录不存在'} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const percent = Math.max(0, Math.min(100, run.progress.percent || 0));
  const nodeLabel =
    run.progress.nodeLabel ??
    (run.progress.nodeId ? run.nodeLabels?.[run.progress.nodeId] : undefined) ??
    run.progress.nodeId;
  const seeds = Object.entries(run.resolvedSeeds);
  const outputs = run.outputs;
  const currentOutput = viewer !== null ? outputs[viewer] : undefined;
  const viewerPos = viewer ?? 0;
  const imageOutputs = outputs.filter((output) => output.kind === 'image');
  const failures = errorLines(run);

  const share = async (output: RunOutput): Promise<void> => {
    const url = new URL(outputUrl(run.id, output.key), window.location.href).toString();
    const data = { title: output.filename, text: run.workflowName, url };
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(data);
        return;
      } catch {
        // User cancelled or sharing is unavailable; fall back to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('链接已复制', 'success');
    } catch {
      showToast('无法分享该文件', 'error');
    }
  };

  const copySeeds = async (): Promise<void> => {
    const text = seeds.map(([name, value]) => `${name}=${value}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showToast(zh.common.copied, 'success');
    } catch {
      showToast('复制失败', 'error');
    }
  };

  return (
    <div className="page run-page">
      <PageHeader
        title={run.workflowName}
        back="/history"
        subtitle={
          <span className="header-chips">
            <StatusBadge state={run.state} />
            <span>{zh.run.elapsed} {elapsedText(run, now)}</span>
          </span>
        }
        actions={
          active ? (
            <button
              type="button"
              className="text-button danger"
              disabled={canceling}
              onClick={() => void cancel()}
            >
              {canceling ? zh.run.canceling : zh.run.cancel}
            </button>
          ) : undefined
        }
      />

      <section className="progress-card">
        <div className="progress-head">
          <span>
            {run.state === 'queued' ? zh.status.queued : run.state === 'running' ? zh.status.running : zh.status[run.state]}
          </span>
          <strong>{percent}%</strong>
        </div>
        <div className={`progress-track${run.state === 'failed' ? ' failed' : ''}${run.state === 'canceled' ? ' canceled' : ''}`}>
          <div
            className={`progress-fill${active && percent === 0 ? ' indeterminate' : ''}`}
            style={{ width: `${Math.max(percent, active ? 6 : 100)}%` }}
          />
        </div>
        <div className="progress-meta">
          {run.state === 'queued' ? (
            <span>
              {zh.run.queued}
              {run.queuePosition !== undefined ? ` · 第 ${run.queuePosition} 位` : ''}
            </span>
          ) : null}
          {run.state === 'running' ? (
            <span>
              {nodeLabel ? `${nodeLabel}` : zh.run.waiting}
              {run.progress.max > 0 ? ` · ${run.progress.value}/${run.progress.max}` : ''}
            </span>
          ) : null}
          {run.state === 'completed' ? <span>{outputs.length} 个结果已生成</span> : null}
          {run.state === 'canceled' ? <span>任务已取消</span> : null}
          {run.state === 'failed' ? <span>{zh.run.failed}</span> : null}
        </div>
      </section>

      {run.state === 'failed' ? (
        <div className="submit-error run-failure" role="alert">
          <Icon name="alert" size={20} />
          <div>
            <strong>{run.error?.message ?? zh.run.failed}</strong>
            {failures.length ? (
              <ul className="error-list">
                {failures.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            ) : null}
            {run.error?.code ? <span className="error-code">{run.error.code}</span> : null}
          </div>
        </div>
      ) : null}

      {seeds.length ? (
        <div className="seed-chips">
          <span className="seed-label">{zh.form.seeded}</span>
          {seeds.map(([name, value]) => (
            <span className="chip" key={name}>{name}: {value}</span>
          ))}
          <button type="button" className="icon-button tiny" aria-label={zh.run.copySeed} onClick={() => void copySeeds()}>
            <Icon name="copy" size={15} />
          </button>
        </div>
      ) : null}

      {outputs.length ? (
        <section className="outputs-section">
          <h2 className="section-label">{zh.run.outputs}<span className="count">{outputs.length}</span></h2>
          <div className="output-grid">
            {outputs.map((output, index) =>
              output.kind === 'image' ? (
                <button
                  type="button"
                  key={output.key}
                  className="output-tile"
                  onClick={() => setViewer(index)}
                >
                  <img
                    src={outputUrl(run.id, output.key, true)}
                    alt={output.filename}
                    loading="lazy"
                  />
                </button>
              ) : output.kind === 'video' ? (
                <div className="output-tile video" key={output.key}>
                  <video
                    src={outputUrl(run.id, output.key)}
                    controls
                    playsInline
                    preload="metadata"
                  />
                </div>
              ) : output.kind === 'audio' ? (
                <div className="output-tile audio" key={output.key}>
                  <Icon name="play" size={22} />
                  <audio src={outputUrl(run.id, output.key)} controls preload="metadata" />
                </div>
              ) : (
                <a
                  className="output-tile file"
                  key={output.key}
                  href={outputUrl(run.id, output.key)}
                  download={downloadName(output)}
                >
                  <Icon name="download" size={22} />
                  <span>{downloadName(output)}</span>
                </a>
              ),
            )}
          </div>
        </section>
      ) : run.state === 'completed' ? (
        <p className="muted-note">{zh.run.noOutputs}</p>
      ) : null}

      <div className="run-actions">
        <button
          type="button"
          className="button primary"
          disabled={rerun || !outputs.length && run.state !== 'completed'}
          onClick={() => void submitAgain()}
        >
          {rerun ? <Spinner size={18} /> : <><Icon name="play" size={18} />{zh.run.rerun}</>}
        </button>
        <button type="button" className="button secondary" onClick={reuse}>
          <Icon name="edit" size={18} />
          {zh.run.reuse}
        </button>
      </div>

      <Modal
        title={currentOutput ? downloadName(currentOutput) : zh.run.outputs}
        open={viewer !== null && Boolean(currentOutput)}
        onClose={() => setViewer(null)}
        footer={
          currentOutput ? (
            <>
              <button type="button" className="button ghost" onClick={() => void share(currentOutput)}>
                <Icon name="share" size={18} />
                {zh.run.share}
              </button>
              <a
                className="button secondary"
                href={outputUrl(run.id, currentOutput.key)}
                download={downloadName(currentOutput)}
              >
                <Icon name="download" size={18} />
                {zh.run.download}
              </a>
            </>
          ) : undefined
        }
      >
        {currentOutput ? (
          <div className="viewer">
            <img
              className="viewer-media"
              src={outputUrl(run.id, currentOutput.key)}
              alt={currentOutput.filename}
            />
            {imageOutputs.length > 1 ? (
              <div className="viewer-nav">
                <button
                  type="button"
                  className="icon-button bordered"
                  aria-label="上一张"
                  onClick={() => {
                    let next = viewerPos - 1;
                    while (next >= 0 && outputs[next]?.kind !== 'image') next -= 1;
                    if (next >= 0) setViewer(next);
                  }}
                >
                  <Icon name="back" size={20} />
                </button>
                <span>
                  {outputs.filter((output, index) => output.kind === 'image' && index <= viewerPos).length}
                  {' / '}
                  {imageOutputs.length}
                </span>
                <button
                  type="button"
                  className="icon-button bordered"
                  aria-label="下一张"
                  onClick={() => {
                    let next = viewerPos + 1;
                    while (next < outputs.length && outputs[next]?.kind !== 'image') next += 1;
                    if (next < outputs.length) setViewer(next);
                  }}
                >
                  <Icon name="chevron" size={20} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
