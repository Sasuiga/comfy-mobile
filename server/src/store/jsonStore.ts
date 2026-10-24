import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * A tiny JSON-document store with atomic writes and per-path write
 * serialization. It intentionally has no database dependency: the data volume
 * is small and a single process owns it.
 */
export class JsonStore {
  readonly root: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  pathFor(relativePath: string): string {
    const full = resolve(this.root, relativePath);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Path escapes data directory: ${relativePath}`);
    }
    return full;
  }

  async read<T>(relativePath: string, fallback: T): Promise<T> {
    const full = this.pathFor(relativePath);
    try {
      const raw = await readFile(full, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) {
        throw new Error(`Corrupt JSON file ${relativePath}: ${error.message}`);
      }
      throw error;
    }
  }

  async readOrNull<T>(relativePath: string): Promise<T | null> {
    const full = this.pathFor(relativePath);
    try {
      return JSON.parse(await readFile(full, 'utf8')) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(relativePath: string, value: unknown): Promise<void> {
    const full = this.pathFor(relativePath);
    const previous = this.locks.get(full) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.writeAtomic(full, value));
    this.locks.set(full, next);
    try {
      await next;
    } finally {
      if (this.locks.get(full) === next) this.locks.delete(full);
    }
  }

  async remove(relativePath: string): Promise<void> {
    const full = this.pathFor(relativePath);
    // Queue behind any write already in flight for this path; otherwise that
    // write would recreate the file right after the unlink.
    const previous = this.locks.get(full) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        unlink(full).catch((error: NodeJS.ErrnoException) => {
          if (error?.code !== 'ENOENT') throw error;
        }),
      );
    this.locks.set(full, next);
    try {
      await next;
    } finally {
      if (this.locks.get(full) === next) this.locks.delete(full);
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await access(this.pathFor(relativePath), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async list(relativeDir: string): Promise<string[]> {
    const full = this.pathFor(relativeDir);
    try {
      const entries = await readdir(full, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async clearDirectory(relativeDir: string): Promise<void> {
    await rm(this.pathFor(relativeDir), { recursive: true, force: true });
  }

  private async writeAtomic(full: string, value: unknown): Promise<void> {
    await mkdir(dirname(full), { recursive: true });
    const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, full);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
