import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

export function registerOutputRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Params: { runId: string; fileKey: string };
    Querystring: { thumb?: string };
  }>('/outputs/:runId/:fileKey', async (request, reply) => {
    const run = await ctx.runs.get(request.params.runId);
    const output = run.outputs.find((item) => item.key === request.params.fileKey);
    if (!output) {
      throw new AppError(404, 'OUTPUT_NOT_FOUND', '输出文件不存在或已被清理');
    }
    const thumb =
      request.query.thumb === '1' ||
      request.query.thumb === 'true' ||
      request.query.thumb === '';
    const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
    const response = await ctx.client.getView(
      {
        filename: output.filename,
        subfolder: output.subfolder,
        type: output.comfyType,
      },
      {
        range,
        thumb: thumb && output.kind === 'image',
      },
    );
    if (!response.ok) {
      if (response.status === 404) {
        throw new AppError(404, 'OUTPUT_NOT_FOUND', 'ComfyUI 上找不到该输出文件');
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError(502, 'COMFY_AUTH', 'ComfyUI 拒绝了输出文件访问');
      }
      throw new AppError(
        response.status >= 500 ? 502 : response.status,
        'OUTPUT_FETCH_FAILED',
        `读取输出文件失败（HTTP ${response.status}）`,
      );
    }
    for (const name of PASSTHROUGH_HEADERS) {
      const value = response.headers.get(name);
      if (value) reply.header(name, value);
    }
    reply.header(
      'Cache-Control',
      thumb ? 'private, max-age=3600' : 'private, max-age=86400',
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    if (!response.body) {
      reply.status(response.status);
      return reply.send();
    }
    reply.status(response.status);
    return reply.send(Readable.fromWeb(response.body as never));
  });
}
