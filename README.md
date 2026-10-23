# Comfy Mobile

A small mobile-first web UI for running workflows that are already saved in
[ComfyUI](https://github.com/comfyanonymous/ComfyUI).

- Lists workflows from ComfyUI's userdata API.
- Turns the important widgets into touch-friendly controls.
- Understands ComfyUI App Builder (`extra.linearData`), `[UI]` node-title
  markers, and sensible automatic detection.
- Runs workflows, shows live progress, and displays images, video and audio.
- Keeps parameter presets and run history in a local JSON data directory.
- Installs as a PWA, so it can be added to a phone's home screen.

## Quick start

```bash
npm install
npm run dev
```

The server listens on `http://localhost:3000`; Vite serves the UI on
`http://localhost:5173` and proxies `/api` to the server.

You can develop without a ComfyUI instance:

```bash
npm run mock:comfy   # a fake ComfyUI on http://127.0.0.1:8188
```

Then open the UI, enter `http://127.0.0.1:8188` in setup, and try the sample
workflow.

## Production

```bash
npm run build
COMFYUI_URL=http://127.0.0.1:8188 npm start
```

Or build the included container:

```bash
docker build -t comfy-mobile .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" \
  -e COMFYUI_URL=http://host.docker.internal:8188 comfy-mobile
```

A general `docker-compose.yml` is included as a starting point.

## Configuration

Environment variables override values saved in `DATA_DIR/config.json`:

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port, default `3000` |
| `HOST` | Bind address, default `0.0.0.0` |
| `DATA_DIR` | Persistent data directory, default `data/` in the repository |
| `WEB_DIST` | Built frontend directory, default `web/dist/` in the repository |
| `COMFYUI_URL` | ComfyUI base URL |
| `COMFYUI_TOKEN` | Bearer token sent to ComfyUI |
| `COMFYUI_HEADERS` | JSON object of extra headers for ComfyUI |
| `COMFYUI_INSECURE` | `true` to accept a self-signed ComfyUI certificate |
| `AUTH_TOKEN` | Optional bearer token required by this UI |
| `UPLOAD_MAX_MB` | Maximum upload size, default `20` |

The settings page can test a connection before saving it. Changing the
ComfyUI URL from the UI has no effect when `COMFYUI_URL` is set in the
environment.

## Choosing what appears in the form

Sources are merged with this priority:

1. Manual overrides saved from the form editor.
2. ComfyUI App Builder selections (`extra.linearData`).
3. Node titles containing `[UI]` or `@ui`.
4. Automatic detection by node class and input name.

Title marker examples:

```text
[UI]                         expose this node's widgets
[UI:正向提示词]               custom label
[UI slider 0 1 0.01]         force a slider with min/max/step
[UI number 1 100 1]          number control
[UI group:高级]               put fields in a group
[UI hide]                    hide this node
```

If no configuration is found, common nodes (prompt, sampler, model loaders,
latent size, image loaders) are shown first and everything else is placed in
the collapsed "高级" group. You can rename, reorder, hide, or change the
control type of any field in the form editor.

## Security notes

- ComfyUI credentials stay on the server.
- The output proxy resolves `runId + fileKey` from saved metadata; it never
  accepts arbitrary filenames.
- Set `AUTH_TOKEN` if the UI is reachable by anyone who should not use it.
- The service is designed for a single user or a small trusted network.

## License

MIT. The vendored UI-to-API workflow converter retains its own MIT license;
see `server/vendor/comfyui-converter/`.
