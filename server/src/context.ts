import type { ConfigService } from './config.js';
import type { AssetStore } from './assets/store.js';
import type { ComfyClient } from './comfy/client.js';
import type { ComfySocket } from './comfy/socket.js';
import type { RunManager } from './runs/manager.js';
import type { JsonStore } from './store/jsonStore.js';
import type { WorkflowRepository } from './workflows/repository.js';
import type { WorkflowService } from './workflows/service.js';

export interface AppContext {
  store: JsonStore;
  config: ConfigService;
  assets: AssetStore;
  client: ComfyClient;
  socket: ComfySocket;
  repository: WorkflowRepository;
  workflows: WorkflowService;
  runs: RunManager;
}
