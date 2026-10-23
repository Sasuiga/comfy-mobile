import type { FastifyInstance } from 'fastify';
import type {
  ImportWorkflowRequest,
  SavePresetRequest,
  WorkflowSaveFieldsRequest,
} from '@comfy-mobile/shared';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { decodeWorkflowKey } from '../security.js';

export function registerWorkflowRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { refresh?: string } }>('/workflows', async (request) => {
    const refresh = request.query.refresh === '1' || request.query.refresh === 'true';
    const items = await ctx.workflows.listWorkflows(refresh);
    return { items };
  });

  app.get<{ Params: { key: string } }>('/workflows/:key', async (request) => {
    const { detail } = await ctx.workflows.getSchema(request.params.key);
    return detail;
  });

  app.get<{ Params: { key: string } }>('/workflows/:key/fields', async (request) => {
    const { detail } = await ctx.workflows.getSchema(request.params.key);
    return {
      workflowKey: detail.key,
      name: detail.name,
      fields: detail.fields,
      groups: detail.groups,
      warnings: detail.warnings,
      staleOverrides: detail.staleOverrides,
    };
  });

  app.put<{ Params: { key: string }; Body: WorkflowSaveFieldsRequest }>(
    '/workflows/:key/fields',
    async (request) => {
      const body = request.body;
      if (!body || !Array.isArray(body.fields)) {
        throw new AppError(400, 'INVALID_BODY', '缺少 fields 数组');
      }
      await ctx.workflows.saveOverrides(request.params.key, body.fields);
      const { detail } = await ctx.workflows.getSchema(request.params.key);
      return detail;
    },
  );

  app.delete<{ Params: { key: string } }>('/workflows/:key/fields', async (request) => {
    await ctx.workflows.resetOverrides(request.params.key);
    const { detail } = await ctx.workflows.getSchema(request.params.key);
    return detail;
  });

  app.post<{ Body: ImportWorkflowRequest }>(
    '/workflows/import',
    { bodyLimit: 5 * 1024 * 1024 },
    async (request) => {
      const body = request.body;
      if (!body || typeof body !== 'object') {
        throw new AppError(400, 'INVALID_BODY', '请提交 JSON 工作流');
      }
      if (!body.workflow || typeof body.workflow !== 'object') {
        throw new AppError(400, 'INVALID_WORKFLOW', '缺少 workflow 字段');
      }
      const summary = await ctx.workflows.importWorkflow(body.name, body.workflow);
      return { item: summary };
    },
  );

  app.delete<{ Params: { key: string } }>('/workflows/:key', async (request) => {
    const decoded = decodeWorkflowKey(request.params.key);
    if (decoded.source !== 'imported') {
      throw new AppError(400, 'NOT_IMPORTED', '只能删除导入的工作流');
    }
    await ctx.workflows.deleteImported(request.params.key);
    return { ok: true };
  });

  app.get<{ Params: { key: string } }>('/workflows/:key/presets', async (request) => {
    const presets = await ctx.workflows.listPresets(request.params.key);
    return { presets };
  });

  app.post<{ Params: { key: string }; Body: SavePresetRequest }>(
    '/workflows/:key/presets',
    async (request) => {
      const preset = await ctx.workflows.createPreset(request.params.key, request.body);
      return { preset };
    },
  );

  app.put<{ Params: { key: string; id: string }; Body: SavePresetRequest }>(
    '/workflows/:key/presets/:id',
    async (request) => {
      const preset = await ctx.workflows.updatePreset(
        request.params.key,
        request.params.id,
        request.body,
      );
      return { preset };
    },
  );

  app.delete<{ Params: { key: string; id: string } }>(
    '/workflows/:key/presets/:id',
    async (request) => {
      await ctx.workflows.deletePreset(request.params.key, request.params.id);
      return { ok: true };
    },
  );
}
