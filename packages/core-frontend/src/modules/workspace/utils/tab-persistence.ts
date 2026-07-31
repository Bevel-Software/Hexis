export interface PersistedTabState {
  paths: string[];
  activePath: string | null;
}

export function tabsKey(workspaceId: string, branch: string): string {
  return `bevel.tabs.${workspaceId}.${branch}`;
}

export function readPersistedTabs(workspaceId: string, branch: string): PersistedTabState {
  try {
    const raw = localStorage.getItem(tabsKey(workspaceId, branch));
    if (!raw) return { paths: [], activePath: null };
    const parsed = JSON.parse(raw) as Partial<PersistedTabState>;
    const paths = Array.isArray(parsed.paths)
      ? parsed.paths.filter((p): p is string => typeof p === 'string')
      : [];
    const activePath = typeof parsed.activePath === 'string' ? parsed.activePath : null;
    return { paths, activePath };
  } catch {
    return { paths: [], activePath: null };
  }
}
