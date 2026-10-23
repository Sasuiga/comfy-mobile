import type { FastifyInstance } from 'fastify';
import type { ProjectListResponse, ProjectSummary } from '@comfy-mobile/shared';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects', async (): Promise<ProjectListResponse> => {
    return ctx.assets.listProjects();
  });

  app.post<{ Body: { name?: string } }>('/projects', async (request) => {
    const name = typeof request.body?.name === 'string' ? request.body.name : '';
    if (!name.trim()) {
      throw new AppError(400, 'INVALID_PROJECT_NAME', '请填写项目名称');
    }
    const item: ProjectSummary = await ctx.assets.createProject(name);
    return { item };
  });

  app.get<{ Querystring: { path?: string } }>('/projects/detail', async (request) => {
    const path = request.query.path ?? '';
    if (!path.trim()) {
      throw new AppError(400, 'INVALID_PROJECT_NAME', '缺少项目路径');
    }
    const item: ProjectSummary = await ctx.assets.getProject(path);
    return { item };
  });

  app.delete<{ Querystring: { path?: string } }>('/projects', async (request) => {
    const path = request.query.path ?? '';
    if (!path.trim()) {
      throw new AppError(400, 'INVALID_PROJECT_NAME', '缺少项目路径');
    }
    await ctx.assets.deleteProject(path);
    return { ok: true };
  });
}
