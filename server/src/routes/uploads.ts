import type { FastifyInstance } from 'fastify';
import type { UploadResponse } from '@comfy-mobile/shared';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { safeFilename } from '../security.js';

const ALLOWED_PREFIXES = ['image/', 'video/', 'audio/'];

export function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/uploads', async (request): Promise<UploadResponse> => {
    let file;
    try {
      file = await request.file();
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(413, 'FILE_TOO_LARGE', `文件不能超过 ${ctx.config.options.maxUploadMb} MB`);
      }
      throw error;
    }
    if (!file) {
      throw new AppError(400, 'NO_FILE', '请选择要上传的文件');
    }
    const mime = file.mimetype || 'application/octet-stream';
    if (!ALLOWED_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
      throw new AppError(400, 'INVALID_FILE_TYPE', '只支持图片、视频或音频文件');
    }
    const filename = safeFilename(file.filename || 'upload', 'upload');
    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(413, 'FILE_TOO_LARGE', `文件不能超过 ${ctx.config.options.maxUploadMb} MB`);
      }
      throw error;
    }
    if (buffer.length > ctx.config.maxUploadBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `文件不能超过 ${ctx.config.options.maxUploadMb} MB`);
    }
    const result = await ctx.client.uploadFile(buffer, filename, mime, 'input');
    return {
      name: result.name,
      subfolder: result.subfolder,
      type: result.type,
      assetHash: result.assetHash,
    };
  });
}
