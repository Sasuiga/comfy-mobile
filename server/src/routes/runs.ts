import type { FastifyInstance } from 'fastify';
import type { RunRecord, SubmitRunRequest } from '@comfy-mobile/shared';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: SubmitRunRequest }>('/runs', async (request) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'INVALID_BODY', '请求体不能为空');
    }
    if (typeof body.workflowKey !== 'string' || !body.workflowKey) {
      throw new AppError(400, 'INVALID_BODY', '缺少 workflowKey');
    }
    if (body.values !== undefined && (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values))) {
      throw new AppError(400, 'INVALID_BODY', 'values 必须是对象');
    }
    if (body.values && Object.keys(body.values).length > 1000) {
      throw new AppError(400, 'INVALID_BODY', '参数数量过多');
    }
    const result = await ctx.runs.submit({
      workflowKey: body.workflowKey,
      values: body.values ?? {},
      presetId: body.presetId,
      randomizeSeeds: Boolean(body.randomizeSeeds),
    });
    return result;
  });

  app.get<{ Querystring: { limit?: string } }>('/runs', async (request) => {
    const raw = Number(request.query.limit ?? 20);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 20;
    return { items: ctx.runs.list(limit) };
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (request) => {
    return ctx.runs.get(request.params.id);
  });

  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (request) => {
    return ctx.runs.cancel(request.params.id);
  });

  app.get<{ Params: { id: string } }>('/runs/:id/events', async (request, reply) => {
    // Load before hijacking so a missing run still produces a normal JSON 404.
    const initial = await ctx.runs.get(request.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    let closed = false;

    const send = (event: string, run: RunRecord): void => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(run)}\n\n`);
    };
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };

    send('snapshot', initial);
    if (TERMINAL.has(initial.state)) {
      send('done', initial);
      closed = true;
      res.end();
      return;
    }

    const unsubscribe = ctx.runs.onUpdate((run) => {
      if (run.id !== initial.id) return;
      send(TERMINAL.has(run.state) ? 'done' : 'update', run);
      if (TERMINAL.has(run.state)) {
        setTimeout(finish, 10);
      }
    });
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
