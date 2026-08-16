import { useEffect } from 'react';
import { useJoinRequests } from '../hooks/useJoinRequests';
import { AccessRequestsBanner } from './AccessRequestsBanner';

/**
 * One plugin's join requests, fetching their own data.
 *
 * A component rather than a hook call in each page because the gallery shows
 * a banner per plugin the caller manages, and a hook cannot be called in a
 * loop. Rendering one of these per plugin keeps that legal and gives the plugin
 * page the identical surface for free.
 *
 * Render it only for plugins the caller MANAGES: the endpoint answers `[]` to
 * everyone else, so an ungated render is harmless but pointlessly chatty.
 */
export interface PluginJoinRequestsProps {
  plugin: string;
  /** The plugin's constituent folders — for the Manage-access affordance. */
  folders: string[];
  onManage(folder: string): void;
  /**
   * Bump to refetch. The pages raise it after the Manage-access dialog
   * closes: granting there can settle a request, and this surface would
   * otherwise keep offering proposals that have already landed until its
   * next natural fetch.
   */
  reloadSignal?: number;
  className?: string;
}

export function PluginJoinRequests({
  plugin,
  folders,
  onManage,
  reloadSignal = 0,
  className,
}: PluginJoinRequestsProps) {
  const requests = useJoinRequests(plugin, folders[0] ?? null);
  const { reload } = requests;

  useEffect(() => {
    if (reloadSignal > 0) reload();
  }, [reloadSignal, reload]);

  return (
    <AccessRequestsBanner
      plugin={plugin}
      folders={folders}
      requests={requests.requests}
      onManage={onManage}
      onAccept={(r, p) => void requests.accept(r, p)}
      onDecline={(r) => void requests.decline(r)}
      className={className}
    />
  );
}
