import { createMockComfyServer } from './server.js';

async function main(): Promise<void> {
  const port = Number(process.env.MOCK_PORT ?? process.env.PORT ?? 8188);
  if (!Number.isFinite(port) || port < 0) {
    console.error('MOCK_PORT must be a valid port number');
    process.exit(1);
  }
  const mock = await createMockComfyServer({
    port,
    host: process.env.MOCK_HOST ?? '127.0.0.1',
    token: process.env.MOCK_TOKEN || undefined,
    stepDelayMs: Number(process.env.MOCK_STEP_DELAY_MS ?? 60),
  });
  console.log(`ComfyUI mock listening at ${mock.url}`);
  console.log('Saved workflows: txt2img-ui.json, txt2img-api.json');
  console.log('Try:');
  console.log(`  curl ${mock.url}/api/userdata?dir=workflows\\&recurse=true\\&full_info=true`);

  const shutdown = async (): Promise<void> => {
    await mock.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
