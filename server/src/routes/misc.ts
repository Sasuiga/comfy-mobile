import type { FastifyInstance } from 'fastify';
import type { HealthResponse, VersionResponse } from '@comfy-mobile/shared';
import { APP_NAME, APP_VERSION } from '../version.js';

export function registerMiscRoutes(app: FastifyInstance): void {
  app.get('/healthz', async (): Promise<HealthResponse> => ({
    ok: true,
    version: APP_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  app.get('/version', async (): Promise<VersionResponse> => ({
    name: APP_NAME,
    version: APP_VERSION,
  }));
}
