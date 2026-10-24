const RECENT_KEY = 'comfy-mobile.recent-workflows';

export function readRecentWorkflows(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Drops a workflow from the recents shortcut, e.g. after it was deleted. */
export function forgetWorkflow(key: string): void {
  try {
    const next = readRecentWorkflows().filter((item) => item !== key);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function rememberWorkflow(key: string): void {
  try {
    const next = [key, ...readRecentWorkflows().filter((item) => item !== key)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}
