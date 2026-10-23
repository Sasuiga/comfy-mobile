import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  noExternal: [/^@comfy-mobile\/shared/],
  external: ['ws', 'undici', 'fastify', '@fastify/static', '@fastify/multipart'],
});
