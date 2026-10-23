import type { FastifyInstance } from 'fastify';
import type { TestConnectionRequest, UpdateConfigRequest } from '@comfy-mobile/shared';
import type { AppContext } from '../context.js';
import { normalizeComfyUrl } from '../config.js';
import { AppError } from '../errors.js';

function buildOverrides(
  ctx: AppContext,
  request: TestConnectionRequest,
): Parameters<AppContext['client']['testConnection']>[0] {
  const current = ctx.config.comfy;
  const overrides: NonNullable<Parameters<AppContext['client']['testConnection']>[0]> = {};
  if (request.comfyUrl !== undefined) {
    const normalized = normalizeComfyUrl(request.comfyUrl);
    if (!normalized) throw new AppError(400, 'INVALID_URL', '请填写 ComfyUI 地址');
    overrides.baseUrl = normalized;
  }
  if (request.token !== undefined) overrides.token = request.token ?? '';
  if (request.headers !== undefined) {
    if (request.headers === null) {
      overrides.headers = {};
    } else {
      overrides.headers = { ...current.headers, ...request.headers };
    }
  }
  if (request.insecure !== undefined) overrides.insecure = Boolean(request.insecure);
  return overrides;
}

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/config', async () => ctx.config.publicView());

  app.post<{ Body: TestConnectionRequest }>('/config/test', async (request) => {
    const body = request.body ?? {};
    const overrides = buildOverrides(ctx, body);
    const result = await ctx.client.testConnection(overrides);
    return result;
  });

  app.put<{ Body: UpdateConfigRequest }>('/config', async (request) => {
    const body = request.body ?? {};
    const overrides = buildOverrides(ctx, {
      comfyUrl: body.comfyUrl,
      token: body.token,
      headers: body.headers,
      insecure: body.insecure,
    });
    const result = await ctx.client.testConnection(overrides);
    if (!result.ok) {
      throw new AppError(502, 'CONNECTION_FAILED', result.error || '连接 ComfyUI 失败', {
        test: result,
      });
    }
    await ctx.config.update(body);
    ctx.config.setConnectionStatus({
      connected: true,
      version: result.comfyVersion,
      capabilities: result.capabilities,
    });
    await ctx.workflows.invalidateCaches({
      workflows: true,
      objectInfo: true,
      conversion: true,
    });
    // Refresh in the background so saving settings stays snappy.
    void ctx.workflows.listWorkflows(true).catch(() => undefined);
    ctx.socket.refresh();
    return {
      config: ctx.config.publicView(),
      test: result,
    };
  });

  app.post<{ Body: { workflows?: boolean; objectInfo?: boolean } }>(
    '/config/refresh',
    async (request) => {
      const body = request.body ?? {};
      const wantObjectInfo = body.objectInfo !== false;
      const wantWorkflows = body.workflows !== false;
      await ctx.workflows.invalidateCaches({
        workflows: wantWorkflows,
        objectInfo: wantObjectInfo,
        conversion: true,
      });
      let objectInfoHash: string | undefined;
      if (wantObjectInfo) {
        const refreshed = await ctx.workflows.refreshObjectInfo();
        objectInfoHash = refreshed.hash;
      }
      let workflowCount: number | undefined;
      if (wantWorkflows) {
        const workflows = await ctx.workflows.listWorkflows(true);
        workflowCount = workflows.length;
      }
      return { ok: true, objectInfoHash, workflowCount };
    },
  );
}
