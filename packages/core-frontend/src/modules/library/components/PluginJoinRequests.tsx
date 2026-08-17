import { useEffect, useLayoutEffect } from 'react';
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
  /**
   * Told whether the banner is actually on screen (it renders nothing while
   * no requests pend). The group page listens so the empty band's chalk
   * arrow can stand down when this banner sits in its line of fire — the
   * arrow's aim assumes nothing between the band and the title row.
   */
  onVisible?(visible: boolean): void;
  className?: string;
}

export function PluginJoinRequests({
  plugin,
  folders,
  onManage,
  reloadSignal = 0,
  onVisible,
  className,
}: PluginJoinRequestsProps) {
  const requests = useJoinRequests(plugin, folders[0] ?? null);
  const { reload } = requests;

  useEffect(() => {
    if (reloadSignal > 0) reload();
  }, [reloadSignal, reload]);

  const visible = requests.requests.length > 0;
  // A LAYOUT effect, because the listener uses this to decide what to draw in
  // the same frame. Requests arrive asynchronously; reported after paint, the
  // banner and the empty band's arrow — which are meant to be mutually
  // exclusive — would both be on screen for one frame. Before paint, the
  // listener's re-render lands in the only frame that is ever drawn.
  useLayoutEffect(() => {
    onVisible?.(visible);
    // Unmounting is the banner leaving the page — say so, or a listener keeps
    // holding a "visible" that nothing on screen backs up.
    return () => onVisible?.(false);
  }, [visible, onVisible]);

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
