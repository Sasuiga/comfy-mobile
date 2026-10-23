import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { AssetEntry, AssetStorageInfo } from '@comfy-mobile/shared';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

const ALLOWED_PREFIXES = ['image/', 'video/', 'audio/'];

function contentDisposition(name: string, download: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (!rawStart && rawEnd) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = rawStart ? Number(rawStart) : 0;
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

export function registerAssetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/assets/info', async (): Promise<AssetStorageInfo> => ctx.assets.info());

  app.get<{ Querystring: { path?: string } }>('/assets/browse', async (request) => {
    return ctx.assets.browseDirs(request.query.path ?? '');
  });

  app.post<{ Body: { path?: string } }>('/assets/select', async (request) => {
    const path = typeof request.body?.path === 'string' ? request.body.path : '';
    if (!path.trim()) throw new AppError(400, 'INVALID_ASSET_PATH', '请选择素材目录');
    return ctx.assets.setWorkspace(path);
  });

  app.get<{ Querystring: { path?: string } }>('/assets/list', async (request) => {
    return ctx.assets.list(request.query.path ?? '');
  });

  app.post<{ Querystring: { path?: string } }>('/assets/upload', async (request) => {
    let file;
    try {
      file = await request.file();
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(
          413,
          'FILE_TOO_LARGE',
          `文件不能超过 ${ctx.config.options.maxUploadMb} MB`,
        );
      }
      throw error;
    }
    if (!file) throw new AppError(400, 'NO_FILE', '请选择要上传的文件');
    const mime = file.mimetype || 'application/octet-stream';
    if (!ALLOWED_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
      throw new AppError(400, 'INVALID_FILE_TYPE', '只支持图片、视频或音频文件');
    }
    const target = await ctx.assets.allocateUpload(
      request.query.path ?? 'inputs',
      file.filename || 'upload',
    );
    try {
      await pipeline(file.file, createWriteStream(target.abs, { flags: 'wx' }));
    } catch (error) {
      await unlink(target.abs).catch(() => undefined);
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(
          413,
          'FILE_TOO_LARGE',
          `文件不能超过 ${ctx.config.options.maxUploadMb} MB`,
        );
      }
      throw error;
    }
    if (file.file.truncated) {
      await unlink(target.abs).catch(() => undefined);
      throw new AppError(
        413,
        'FILE_TOO_LARGE',
        `文件不能超过 ${ctx.config.options.maxUploadMb} MB`,
      );
    }
    const item: AssetEntry = await ctx.assets.describe(target.rel);
    return { item };
  });

  app.get<{ Querystring: { path?: string; download?: string } }>(
    '/assets/file',
    async (request, reply) => {
      const path = request.query.path ?? '';
      const info = await ctx.assets.fileInfo(path);
      const download =
        request.query.download === '1' || request.query.download === 'true';
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'private, max-age=86400');
      reply.header('Content-Disposition', contentDisposition(info.name, download));
      reply.header('X-Content-Type-Options', 'nosniff');
      const type = info.contentType ?? 'application/octet-stream';
      const rangeHeader =
        typeof request.headers.range === 'string' ? request.headers.range : undefined;
      if (rangeHeader) {
        const range = parseRange(rangeHeader, info.size);
        if (range === 'invalid') {
          reply.header('Content-Range', `bytes */${info.size}`);
          return reply.code(416).send();
        }
        if (range) {
          reply.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
          reply.header('Content-Length', range.end - range.start + 1);
          reply.header('Content-Type', type);
          return reply
            .code(206)
            .send(createReadStream(info.abs, { start: range.start, end: range.end }));
        }
      }
      reply.header('Content-Length', info.size);
      reply.header('Content-Type', type);
      return reply.send(createReadStream(info.abs));
    },
  );

  app.delete<{ Querystring: { path?: string } }>('/assets/file', async (request) => {
    const path = request.query.path ?? '';
    if (!path.trim()) throw new AppError(400, 'INVALID_ASSET_PATH', '缺少素材路径');
    await ctx.assets.delete(path);
    return { ok: true };
  });
}
