# Comfy Mobile

A small mobile-first web UI for running workflows that are already saved in
[ComfyUI](https://github.com/comfyanonymous/ComfyUI).

- Organizes work into projects. A project is just a folder under the project
  root, holding its own input assets, archived outputs and run history.
- Lists workflows from ComfyUI's userdata API only when you are generating;
  the home screen shows projects instead.
- Browses ComfyUI's bundled template library and imports a template as a
  local workflow with one tap.
- Turns the important widgets into touch-friendly controls.
- Understands ComfyUI App Builder (`extra.linearData`), `[UI]` node-title
  markers, and sensible automatic detection.
- Runs workflows, shows live progress, and displays images, video and audio.
- Keeps project files in a chosen directory, with a built-in asset browser
  for uploading, picking, downloading and deleting files.
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
| `ASSET_ROOT` | Root directory that the project root may be chosen under, default `DATA_DIR/assets` |
| `COMFYUI_URL` | ComfyUI base URL |
| `COMFYUI_TOKEN` | Bearer token sent to ComfyUI |
| `COMFYUI_HEADERS` | JSON object of extra headers for ComfyUI |
| `COMFYUI_INSECURE` | `true` to accept a self-signed ComfyUI certificate |
| `AUTH_TOKEN` | Optional bearer token required by this UI |
| `UPLOAD_MAX_MB` | Maximum upload size, default `20` |

The settings page can test a connection before saving it. Changing the
ComfyUI URL from the UI has no effect when `COMFYUI_URL` is set in the
environment.

## Projects and assets

`ASSET_ROOT` is the only directory tree the service browses. Choose a project
root under it in **Settings → 项目存储** (default `ComfyMobile`). Every folder
directly under that root is a project; create one from the home screen.

New projects are created with a creation-date prefix, like Avalon task folders:
typing `秋季海报` creates `20261023-秋季海报` (local date, `YYYYMMDD-`). The UI
shows the title without the prefix, plus the creation date. Existing folders
are never renamed, so hand-made names such as `项目A` keep working.

```text
<project root>/
├── 默认项目/              # project-less runs and pre-project files
│   ├── inputs/
│   └── outputs/YYYY/MM/
├── 20261023-秋季海报/
│   ├── inputs/
│   └── outputs/YYYY/MM/
└── 项目A/                 # an older, undated folder
    ├── inputs/
    └── outputs/YYYY/MM/
```

- The app always keeps a `默认项目` (`DEFAULT_PROJECT`) for test workflows and
  runs that do not specify a project. Paths starting with `inputs/` or
  `outputs/` are treated as legacy paths and resolve inside it.
- On first start after upgrading, existing root-level `inputs/` and
  `outputs/` are moved into `默认项目/`. Existing names are never overwritten.
- Files uploaded from a project or an image control are stored in that
  project's `inputs/`, and are also uploaded to ComfyUI when a run starts
  (cached by path, size and modification time).
- Every file produced by a run is copied into
  `<project>/outputs/YYYY/MM/` after the run completes. If copying fails, the
  run still succeeds, the original ComfyUI output stays available, and the
  output records an `archiveError`.
- Deleting an asset removes the file immediately; deleting a project removes
  its whole folder. There is no recycle bin. Run history is kept when a
  project is deleted.
- When `ASSET_ROOT` is unset or not writable, the service falls back to
  `DATA_DIR/assets` and shows a warning on the project and settings pages.
- `/assets` (linked from settings) still browses the whole project root for
  troubleshooting.

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
