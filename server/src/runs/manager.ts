import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  RunError,
  RunOutput,
  RunProgress,
  RunRecord,
  RunState,
  RunSummary,
  SubmitRunRequest,
  SubmitRunResponse,
  WorkflowDetail,
} from '@comfy-mobile/shared';
import type { ComfyClient, HistoryEntry } from '../comfy/client.js';
import type { ConfigService } from '../config.js';
import type { ComfySocket, ComfySocketEvent } from '../comfy/socket.js';
import { AppError, toErrorMessage } from '../errors.js';
import type { JsonStore } from '../store/jsonStore.js';
import { mapNodeErrors, type MappedNodeError } from '../workflows/patch.js';
import type { WorkflowService } from '../workflows/service.js';

interface RunIndexFile {
  runs: RunSummary[];
}

const MAX_RUNS = 200;
const POLL_INTERVAL_MS = 2_500;

function nowIso(): string {
  return new Date().toISOString();
}

function baseProgress(): RunProgress {
  return { value: 0, max: 0, percent: 0 };
}

function extensionToKind(filename: string): RunOutput['kind'] {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return 'audio';
  return 'file';
}

function extensionToMime(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
  };
  return map[ext];
}

function outputKindForField(field: string, filename: string): RunOutput['kind'] {
  const lower = field.toLowerCase();
  if (lower.includes('video') || lower.includes('gif')) {
    if (lower.includes('gif')) return 'image';
    return 'video';
  }
  if (lower.includes('audio')) return 'audio';
  if (lower.includes('image') || lower.includes('preview')) return 'image';
  return extensionToKind(filename);
}

export function extractOutputs(entry: HistoryEntry): RunOutput[] {
  const outputs: RunOutput[] = [];
  if (!entry.outputs || typeof entry.outputs !== 'object') return outputs;
  let sequence = 0;
  for (const [nodeId, nodeOutputs] of Object.entries(entry.outputs)) {
    if (!nodeOutputs || typeof nodeOutputs !== 'object') continue;
    for (const [field, rawList] of Object.entries(nodeOutputs)) {
      if (!Array.isArray(rawList)) continue;
      for (const rawItem of rawList) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        if (typeof item.filename !== 'string') continue;
        const filename = item.filename;
        const kind = outputKindForField(field, filename);
        sequence += 1;
        outputs.push({
          key: `out_${sequence}`,
          nodeId,
          kind,
          filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          comfyType: typeof item.type === 'string' ? item.type : 'output',
          contentType: extensionToMime(filename),
          width: typeof item.width === 'number' ? item.width : undefined,
          height: typeof item.height === 'number' ? item.height : undefined,
        });
      }
    }
  }
  return outputs;
}

function extractHistoryError(entry: HistoryEntry): RunError {
  const status = entry.status;
  const messages = Array.isArray(status?.messages) ? status.messages : [];
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue;
    const [eventName, dataRaw] = message;
    if (eventName !== 'execution_error' || !dataRaw || typeof dataRaw !== 'object') continue;
    const data = dataRaw as Record<string, unknown>;
    return {
      code: 'EXECUTION_ERROR',
      message:
        typeof data.exception_message === 'string'
          ? data.exception_message
          : 'ComfyUI 执行失败',
      details: data,
    };
  }
  return { code: 'EXECUTION_ERROR', message: 'ComfyUI 执行失败', details: { status } };
}

function summarize(run: RunRecord): RunSummary {
  const thumbnail = run.outputs.find((output) => output.kind === 'image');
  return {
    id: run.id,
    promptId: run.promptId,
    workflowKey: run.workflowKey,
    workflowName: run.workflowName,
    state: run.state,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    outputCount: run.outputs.length,
    errorMessage: run.error?.message,
    thumbnail: thumbnail ? `/api/outputs/${run.id}/${thumbnail.key}?thumb=1` : undefined,
  };
}

function cloneRun(run: RunRecord): RunRecord {
  return structuredClone(run);
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly summaries: RunSummary[] = [];
  private readonly byPrompt = new Map<string, string>();
  private readonly persistTimers = new Map<string, NodeJS.Timeout>();
  private readonly missingSince = new Map<string, number>();
  private readonly events = new EventEmitter();
  private pollTimer?: NodeJS.Timeout;
  private started = false;

  constructor(
    private readonly store: JsonStore,
    private readonly client: ComfyClient,
    private readonly socket: ComfySocket,
    private readonly workflows: WorkflowService,
    private readonly config: ConfigService,
  ) {
    this.events.setMaxListeners(0);
  }

  async load(): Promise<void> {
    const index = await this.store.read<RunIndexFile>('runs/index.json', { runs: [] });
    if (Array.isArray(index.runs)) {
      for (const summary of index.runs.slice(0, MAX_RUNS)) {
        if (!summary || typeof summary.id !== 'string') continue;
        this.summaries.push(summary);
      }
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.socket.on('event', this.onSocketEvent);
    this.pollTimer = setInterval(() => {
      void this.pollActiveRuns();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    void this.reconcile();
  }

  stop(): void {
    this.started = false;
    this.socket.off('event', this.onSocketEvent);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
  }

  onUpdate(listener: (run: RunRecord) => void): () => void {
    this.events.on('update', listener);
    return () => this.events.off('update', listener);
  }

  async submit(request: SubmitRunRequest): Promise<SubmitRunResponse> {
    const randomizeSeeds = Boolean(request.randomizeSeeds);
    let prepared;
    try {
      prepared = await this.workflows.prepareRun(
        request.workflowKey,
        request.values ?? {},
        randomizeSeeds,
      );
    } catch (error) {
      throw error;
    }
    const { detail, schema, runtime, applied } = prepared;

    let submitted;
    try {
      submitted = await this.client.submitPrompt(applied.prompt);
    } catch (error) {
      if (error instanceof AppError) {
        const mapped: MappedNodeError[] = mapNodeErrors(error.details, schema.fields);
        if (mapped.length) {
          throw new AppError(422, 'NODE_ERRORS', 'ComfyUI 拒绝了工作流', {
            nodeErrors: mapped,
            comfy: error.details,
          });
        }
      }
      throw error;
    }

    const createdAt = nowIso();
    const run: RunRecord = {
      id: randomUUID(),
      promptId: submitted.promptId,
      workflowKey: request.workflowKey,
      workflowName: detail.name,
      state: 'queued',
      progress: baseProgress(),
      createdAt,
      values: sanitizeValues(request.values ?? {}),
      resolvedSeeds: applied.resolvedSeeds,
      outputs: [],
      queuePosition: submitted.number,
      nodeLabels: runtime.nodeLabels,
    };
    this.runs.set(run.id, run);
    this.byPrompt.set(submitted.promptId, run.id);
    this.summaries.unshift(summarize(run));
    this.trim();
    await this.persistRun(run);
    await this.persistIndex();
    this.emit(run);

    return {
      runId: run.id,
      promptId: submitted.promptId,
      resolvedSeeds: applied.resolvedSeeds,
      warnings: prepared.warnings,
    };
  }

  async get(id: string): Promise<RunRecord> {
    const inMemory = this.runs.get(id);
    if (inMemory) return cloneRun(inMemory);
    if (!/^[a-f0-9-]{20,}$/i.test(id)) {
      throw new AppError(404, 'RUN_NOT_FOUND', '运行记录不存在');
    }
    const stored = await this.store.readOrNull<RunRecord>(`runs/${id}.json`);
    if (!stored) throw new AppError(404, 'RUN_NOT_FOUND', '运行记录不存在');
    this.runs.set(id, stored);
    if (stored.promptId) this.byPrompt.set(stored.promptId, id);
    return cloneRun(stored);
  }

  list(limit = 20): RunSummary[] {
    return this.summaries.slice(0, Math.max(0, Math.min(limit, MAX_RUNS))).map((item) => ({ ...item }));
  }

  async cancel(id: string): Promise<RunRecord> {
    const run = await this.getMutable(id);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', '运行记录不存在');
    if (['completed', 'failed', 'canceled'].includes(run.state)) return cloneRun(run);
    if (!run.promptId) throw new AppError(409, 'NO_PROMPT_ID', '任务尚未提交到 ComfyUI');
    let canceled = false;
    try {
      canceled = await this.client.cancelJob(run.promptId);
    } catch {
      canceled = false;
    }
    if (!canceled) {
      try {
        await this.client.deleteQueueItems([run.promptId]);
        canceled = true;
      } catch {
        canceled = false;
      }
    }
    if (run.state === 'running') {
      try {
        await this.client.interrupt();
        canceled = true;
      } catch {
        // keep the previous result
      }
    }
    if (!canceled) {
      throw new AppError(502, 'CANCEL_FAILED', '无法取消任务，ComfyUI 没有响应或任务已结束');
    }
    await this.transition(run, 'canceled', { finishedAt: nowIso() });
    return cloneRun(run);
  }

  private async getMutable(id: string): Promise<RunRecord | undefined> {
    const inMemory = this.runs.get(id);
    if (inMemory) return inMemory;
    try {
      const run = await this.get(id);
      const mutable = this.runs.get(id);
      return mutable ?? run;
    } catch {
      return undefined;
    }
  }

  private onSocketEvent = (event: ComfySocketEvent): void => {
    const run = this.runForEvent(event.data);
    if (!run) return;
    switch (event.type) {
      case 'execution_start': {
        run.startedAt ??= nowIso();
        run.state = 'running';
        run.progress = { ...run.progress, message: '开始执行' };
        this.touch(run);
        break;
      }
      case 'executing': {
        const nodeId = event.data.node;
        if (nodeId === null || nodeId === undefined) {
          void this.finalizeFromHistory(run);
          return;
        }
        run.state = 'running';
        run.startedAt ??= nowIso();
        const id = String(nodeId);
        run.progress = {
          ...run.progress,
          nodeId: id,
          nodeLabel: run.nodeLabels?.[id] ?? id,
          message: '执行节点',
        };
        this.touch(run);
        break;
      }
      case 'progress': {
        const value = Number(event.data.value) || 0;
        const max = Number(event.data.max) || 0;
        run.state = 'running';
        run.startedAt ??= nowIso();
        const nodeId =
          event.data.node !== undefined && event.data.node !== null
            ? String(event.data.node)
            : run.progress.nodeId;
        run.progress = {
          value,
          max,
          percent: max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : run.progress.percent,
          nodeId,
          nodeLabel: nodeId ? run.nodeLabels?.[nodeId] ?? nodeId : run.progress.nodeLabel,
          message: max > 0 ? `采样 ${value}/${max}` : '执行中',
        };
        this.touch(run);
        break;
      }
      case 'progress_state': {
        const nodes = event.data.nodes;
        if (nodes && typeof nodes === 'object') {
          let bestValue = 0;
          let bestMax = 0;
          let label: string | undefined;
          for (const [nodeId, raw] of Object.entries(nodes as Record<string, unknown>)) {
            if (!raw || typeof raw !== 'object') continue;
            const state = raw as Record<string, unknown>;
            const value = Number(state.value) || 0;
            const max = Number(state.max) || 0;
            if (max > 0 && value / max >= (bestMax ? bestValue / bestMax : 0)) {
              bestValue = value;
              bestMax = max;
              label = run.nodeLabels?.[nodeId] ?? nodeId;
            }
          }
          if (bestMax > 0) {
            run.progress = {
              value: bestValue,
              max: bestMax,
              percent: (bestValue / bestMax) * 100,
              nodeLabel: label,
              message: `采样 ${bestValue}/${bestMax}`,
            };
            run.state = 'running';
            this.touch(run);
          }
        }
        break;
      }
      case 'execution_error': {
        const nodeId = event.data.node_id;
        const message =
          typeof event.data.exception_message === 'string'
            ? event.data.exception_message
            : 'ComfyUI 执行失败';
        const error: RunError = {
          code: 'EXECUTION_ERROR',
          message,
          details: event.data,
        };
        void this.transition(run, 'failed', {
          error,
          finishedAt: nowIso(),
          progress: {
            ...run.progress,
            nodeId: nodeId !== undefined && nodeId !== null ? String(nodeId) : run.progress.nodeId,
            nodeLabel:
              nodeId !== undefined && nodeId !== null
                ? run.nodeLabels?.[String(nodeId)] ?? String(nodeId)
                : run.progress.nodeLabel,
            message,
          },
        });
        break;
      }
      case 'execution_interrupted': {
        void this.transition(run, 'canceled', {
          finishedAt: nowIso(),
          progress: { ...run.progress, message: '已取消' },
        });
        break;
      }
      case 'executed': {
        const nodeId = event.data.node;
        if (nodeId !== undefined && nodeId !== null) {
          const id = String(nodeId);
          run.progress = {
            ...run.progress,
            nodeId: id,
            nodeLabel: run.nodeLabels?.[id] ?? id,
            message: '节点完成',
          };
          this.touch(run);
        }
        break;
      }
      case 'status': {
        // queue_remaining is global; keep it out of individual runs.
        break;
      }
      default:
        break;
    }
  };

  private runForEvent(data: Record<string, unknown>): RunRecord | undefined {
    const promptId =
      typeof data.prompt_id === 'string'
        ? data.prompt_id
        : typeof data.promptId === 'string'
          ? data.promptId
          : undefined;
    if (promptId) {
      const id = this.byPrompt.get(promptId);
      if (id) return this.runs.get(id);
      return undefined;
    }
    const active = [...this.runs.values()].filter(
      (run) => run.state === 'queued' || run.state === 'running',
    );
    return active.length === 1 ? active[0] : undefined;
  }

  private touch(run: RunRecord): void {
    this.updateSummary(run);
    this.emit(run);
    this.schedulePersist(run);
  }

  private emit(run: RunRecord): void {
    this.events.emit('update', cloneRun(run));
  }

  private schedulePersist(run: RunRecord): void {
    if (this.persistTimers.has(run.id)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(run.id);
      void this.persistRun(run);
    }, 400);
    timer.unref?.();
    this.persistTimers.set(run.id, timer);
  }

  private async transition(
    run: RunRecord,
    state: RunState,
    patch: Partial<RunRecord> = {},
  ): Promise<void> {
    if (['completed', 'failed', 'canceled'].includes(run.state)) return;
    Object.assign(run, patch, { state });
    if (state !== 'running' && state !== 'queued') {
      run.finishedAt ??= nowIso();
      const timer = this.persistTimers.get(run.id);
      if (timer) clearTimeout(timer);
      this.persistTimers.delete(run.id);
      this.missingSince.delete(run.id);
    }
    this.updateSummary(run);
    this.emit(run);
    await this.persistRun(run);
    await this.persistIndex();
  }

  private updateSummary(run: RunRecord): void {
    const index = this.summaries.findIndex((item) => item.id === run.id);
    const summary = summarize(run);
    if (index >= 0) this.summaries[index] = summary;
    else this.summaries.unshift(summary);
  }

  private trim(): void {
    if (this.summaries.length <= MAX_RUNS) return;
    const removed = this.summaries.splice(MAX_RUNS);
    for (const summary of removed) {
      if (this.runs.get(summary.id)?.state === 'running') continue;
      void this.store.remove(`runs/${summary.id}.json`);
    }
  }

  private async persistRun(run: RunRecord): Promise<void> {
    await this.store.write(`runs/${run.id}.json`, run).catch(() => undefined);
  }

  private async persistIndex(): Promise<void> {
    this.trim();
    await this.store
      .write('runs/index.json', { runs: this.summaries.slice(0, MAX_RUNS) } satisfies RunIndexFile)
      .catch(() => undefined);
  }

  async finalizeFromHistory(run: RunRecord): Promise<void> {
    if (['completed', 'failed', 'canceled'].includes(run.state)) return;
    if (!run.promptId) return;
    let entry: HistoryEntry | null = null;
    try {
      entry = await this.client.getHistory(run.promptId);
      if (!entry && this.config.publicView().capabilities?.historyV2) {
        entry = await this.client.getHistoryV2(run.promptId);
      }
    } catch {
      return;
    }
    if (!entry) return;
    const status = entry.status;
    if (status?.status_str === 'error') {
      await this.transition(run, 'failed', {
        error: extractHistoryError(entry),
        finishedAt: nowIso(),
      });
      return;
    }
    const outputs = extractOutputs(entry);
    await this.transition(run, 'completed', {
      outputs,
      finishedAt: nowIso(),
      progress: {
        value: run.progress.max || 1,
        max: run.progress.max || 1,
        percent: 100,
        nodeId: run.progress.nodeId,
        nodeLabel: run.progress.nodeLabel,
        message: '完成',
      },
    });
  }

  private async pollActiveRuns(): Promise<void> {
    const active = [...this.runs.values()].filter(
      (run) => (run.state === 'queued' || run.state === 'running') && run.promptId,
    );
    if (!active.length) return;
    let queue: { running: unknown[]; pending: unknown[] } | undefined;
    try {
      queue = await this.client.getQueue();
    } catch {
      queue = undefined;
    }
    const queuedIds = new Set<string>();
    if (queue) {
      const collect = (items: unknown[]): void => {
        for (const item of items) {
          if (Array.isArray(item) && typeof item[1] === 'string') queuedIds.add(item[1]);
        }
      };
      collect(queue.running);
      collect(queue.pending);
    }
    for (const run of active) {
      if (!run.promptId) continue;
      let entry: HistoryEntry | null = null;
      try {
        entry = await this.client.getHistory(run.promptId);
        if (!entry && this.config.publicView().capabilities?.historyV2) {
          entry = await this.client.getHistoryV2(run.promptId);
        }
      } catch {
        // A transient failure should not kill the run; try again next tick.
      }
      if (entry) {
        this.missingSince.delete(run.id);
        await this.finalizeFromHistory(run);
        continue;
      }
      const inQueue = queuedIds.size ? queuedIds.has(run.promptId) : undefined;
      if (inQueue === true) {
        this.missingSince.delete(run.id);
        if (run.state === 'queued' && queue) {
          const position = queue.pending.findIndex(
            (item) => Array.isArray(item) && item[1] === run.promptId,
          );
          if (position >= 0) {
            run.queuePosition = position + 1;
            this.touch(run);
          }
        }
        continue;
      }
      if (inQueue === false) {
        const since = this.missingSince.get(run.id) ?? Date.now();
        this.missingSince.set(run.id, since);
        // Give ComfyUI a moment to populate history after the websocket's
        // completion event; after that, the run is genuinely lost.
        if (Date.now() - since > 20_000) {
          await this.transition(run, 'failed', {
            error: {
              code: 'RUN_LOST',
              message: '任务已不在 ComfyUI 队列，也找不到执行结果（可能服务重启或任务被清除）',
            },
            finishedAt: nowIso(),
          });
        }
      }
    }
  }

  private async reconcile(): Promise<void> {
    if (this.config.setupRequired) return;
    const activeSummaries = this.summaries.filter(
      (summary) => summary.state === 'queued' || summary.state === 'running',
    );
    for (const summary of activeSummaries) {
      let run: RunRecord;
      try {
        run = await this.get(summary.id);
      } catch {
        continue;
      }
      this.runs.set(run.id, run);
      if (run.promptId) this.byPrompt.set(run.promptId, run.id);
      if (!run.promptId) {
        await this.transition(run, 'failed', {
          error: { code: 'SERVER_RESTART', message: '服务重启，任务未提交完成' },
          finishedAt: nowIso(),
        });
        continue;
      }
      let entry: HistoryEntry | null = null;
      try {
        entry = await this.client.getHistory(run.promptId);
      } catch {
        // keep it active and let polling decide
      }
      if (entry) {
        await this.finalizeFromHistory(run);
        continue;
      }
      try {
        const queue = await this.client.getQueue();
        const inQueue = [...queue.running, ...queue.pending].some(
          (item) => Array.isArray(item) && item[1] === run.promptId,
        );
        if (!inQueue) {
          await this.transition(run, 'failed', {
            error: {
              code: 'SERVER_RESTART',
              message: '服务重启，ComfyUI 队列中已找不到该任务',
            },
            finishedAt: nowIso(),
          });
        }
      } catch {
        // leave active
      }
    }
  }

  async getNodeErrorsForDetails(details: unknown, workflow: WorkflowDetail): Promise<MappedNodeError[]> {
    return mapNodeErrors(details, workflow.fields);
  }
}

function sanitizeValues(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}
