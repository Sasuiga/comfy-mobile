import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { ApiErrorBody } from '@comfy-mobile/shared';
import { ConfigService, readRuntimeOptions, type RuntimeOptions } from './config.js';
import { AssetStore } from './assets/store.js';
import { ComfyClient } from './comfy/client.js';
import { ComfySocket } from './comfy/socket.js';
import type { AppContext } from './context.js';
import { AppError, toErrorMessage } from './errors.js';
import { RunManager } from './runs/manager.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerOutputRoutes } from './routes/outputs.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { requireAuth, sameOriginGuard } from './security.js';
import { JsonStore } from './store/jsonStore.js';
import { WorkflowRepository } from './workflows/repository.js';
import { WorkflowService } from './workflows/service.js';

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  dataDir?: string;
  webDist?: string;
  background?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  options: RuntimeOptions;
  startBackground: () => Promise<void>;
}

export async function buildApp(buildOptions: BuildAppOptions = {}): Promise<BuiltApp> {
  const env = buildOptions.env ?? process.env;
  const options = readRuntimeOptions(env);
  if (buildOptions.dataDir) options.dataDir = buildOptions.dataDir;
  if (buildOptions.webDist) options.webDist = buildOptions.webDist;

  const store = new JsonStore(options.dataDir);
  const configService = new ConfigService(store, options);
  await configService.load();
  const assets = new AssetStore(configService);
  await assets.init();
  const client = new ComfyClient(configService);
  const repository = new WorkflowRepository(store, client);
  const workflows = new WorkflowService(store, repository, client, assets);
  await workflows.load();
  const socket = new ComfySocket(client, configService);
  const runs = new RunManager(store, client, socket, workflows, configService, assets);
  await runs.load();

  const app = Fastify({
    logger:
      buildOptions.logger === false
        ? false
        : {
            level: options.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-auth-token"]',
                'req.headers["comfyui-token"]',
              ],
              censor: '[redacted]',
            },
          },
    bodyLimit: 6 * 1024 * 1024,
    trustProxy: true,
    requestTimeout: 120_000,
  });

  const ctx: AppContext = {
    store,
    config: configService,
    assets,
    client,
    socket,
    repository,
    workflows,
    runs,
  };

  const authHook = requireAuth(configService.authToken);
  const originHook = sameOriginGuard();

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
        "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; " +
        "manifest-src 'self'; worker-src 'self' blob:",
    );
    const path = request.url.split('?')[0] ?? '';
    if (path.startsWith('/api/') && path !== '/api/healthz' && path !== '/api/version') {
      await authHook(request, reply);
      await originHook(request);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      };
      return reply.code(error.statusCode).send(body);
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      return reply.code(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: '请求内容过大' },
      } satisfies ApiErrorBody);
    }
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'FILE_TOO_LARGE', message: '上传文件过大' },
      } satisfies ApiErrorBody);
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: toErrorMessage(error) || '请求参数不合法' },
      } satisfies ApiErrorBody);
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: toErrorMessage(error) || '服务器内部错误' },
    } satisfies ApiErrorBody);
  });

  await app.register(multipart, {
    limits: {
      fileSize: configService.maxUploadBytes,
      files: 1,
      fields: 20,
    },
  });

  await app.register(
    async (api) => {
      registerMiscRoutes(api);
      registerConfigRoutes(api, ctx);
      registerAssetRoutes(api, ctx);
      registerProjectRoutes(api, ctx);
      registerWorkflowRoutes(api, ctx);
      registerUploadRoutes(api, ctx);
      registerRunRoutes(api, ctx);
      registerOutputRoutes(api, ctx);
    },
    { prefix: '/api' },
  );

  const webDist = resolve(options.webDist);
  const hasWeb = existsSync(join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: ['index.html'],
      maxAge: '1h',
      immutable: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split('?')[0] ?? '';
    if (url.startsWith('/api/')) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: '接口不存在' },
      } satisfies ApiErrorBody);
    }
    if (hasWeb && (request.method === 'GET' || request.method === 'HEAD')) {
      return reply.sendFile('index.html', { maxAge: 0, immutable: false });
    }
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: '页面不存在' },
    } satisfies ApiErrorBody);
  });

  app.addHook('onClose', async () => {
    runs.stop();
    socket.stop();
    client.dispose();
  });

  let backgroundStarted = false;
  const startBackground = async (): Promise<void> => {
    if (backgroundStarted) return;
    backgroundStarted = true;
    if (!configService.setupRequired) {
      try {
        const result = await client.testConnection();
        configService.setConnectionStatus({
          connected: result.ok,
          version: result.comfyVersion,
          capabilities: result.capabilities,
        });
      } catch {
        configService.markDisconnected();
      }
      void workflows.listWorkflows().catch(() => undefined);
    }
    socket.start();
    runs.start();
  };

  if (buildOptions.background) await startBackground();

  return { app, ctx, options, startBackground };
}

export async function closeApp(app: FastifyInstance): Promise<void> {
  await app.close();
}
