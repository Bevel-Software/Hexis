import { authFetch } from '../../../lib/api';

/**
 * What the reader named their own personal plugin, or null when they gave it
 * none — the backend's `GET /api/plugins/personal`, which reads the manifest
 * `displayName` (set by `my_plugin`'s `name` or written into `plugin.json`).
 * The plugin list never carries it: the catalog lists no personal folder.
 */
export async function getPersonalPluginName(): Promise<string | null> {
  const res = await authFetch('/api/plugins/personal');
  if (!res.ok) throw new Error("Couldn't read your personal plugin's name.");
  const body = (await res.json()) as { name?: unknown };
  return typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
}
