import { buildApp } from './app.js';

async function main(): Promise<void> {
  const { app, options, startBackground } = await buildApp({ background: true });
  try {
    await app.listen({ port: options.port, host: options.host });
    app.log.info(
      { port: options.port, host: options.host, dataDir: options.dataDir },
      'comfy-mobile started',
    );
    if (options.comfyUrlEnv) {
      app.log.info(
        { comfyUrl: options.comfyUrlEnv },
        'ComfyUI URL is fixed by COMFYUI_URL',
      );
    }
  } catch (error) {
    app.log.error(error, 'failed to start');
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // startBackground is idempotent; this is a no-op because background:true
  // already started it.
  void startBackground;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
