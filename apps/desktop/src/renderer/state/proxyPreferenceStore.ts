// Renderer mirror of the proxy-preference ProjectSettings fields
// (prefer_proxies + proxy_overrides + generate_preview_proxies +
// export_masters + copy_media_on_import). PixiPreview reads it live per
// ensureClip; the UI subscribes via atomic selectors. Setters write
// through the unrecorded update_project_settings mutation, then update
// the store optimistically (updateProjectSettings returns void). Follows
// the appSettingsStore pattern. See docs/preview.md §Proxies.

import { create } from "zustand";

import type { ExportMasters } from "../../shared/exportMasters";
import { getProjectSettings, updateProjectSettings } from "../ipc";
import { useProjectStore } from "./projectStore";

interface ProxyPrefState {
  preferProxies: boolean;
  /// When false the import/open fan-out skips building the preview (quick)
  /// proxy. Mirrors `ProjectSettings.generate_preview_proxies`.
  generatePreviewProxies: boolean;
  /// When a proxied source's export master is built. Mirrors
  /// `ProjectSettings.export_masters`.
  exportMasters: ExportMasters;
  /// When false, an import leaves the file where it is instead of copying it
  /// into the project. Mirrors `ProjectSettings.copy_media_on_import`.
  copyMediaOnImport: boolean;
  overrides: Record<string, boolean>;
  hydrate: (v: {
    preferProxies: boolean;
    generatePreviewProxies: boolean;
    exportMasters: ExportMasters;
    copyMediaOnImport: boolean;
    overrides: Record<string, boolean>;
  }) => void;
}

export const useProxyPrefStore = create<ProxyPrefState>((set) => ({
  preferProxies: false,
  generatePreviewProxies: true,
  exportMasters: "auto",
  copyMediaOnImport: true,
  overrides: {},
  hydrate: (v) =>
    set({
      preferProxies: v.preferProxies,
      generatePreviewProxies: v.generatePreviewProxies,
      exportMasters: v.exportMasters,
      copyMediaOnImport: v.copyMediaOnImport,
      overrides: v.overrides,
    }),
}));

/** Effective per-clip intent: a per-clip override wins over the global toggle. */
export function proxyIntent(mediaId: string): boolean {
  const s = useProxyPrefStore.getState();
  return s.overrides[mediaId] ?? s.preferProxies;
}

export async function setPreferProxies(v: boolean): Promise<void> {
  await updateProjectSettings({ prefer_proxies: v });
  useProxyPrefStore.setState({ preferProxies: v });
}

export async function setGeneratePreviewProxies(v: boolean): Promise<void> {
  await updateProjectSettings({ generate_preview_proxies: v });
  useProxyPrefStore.setState({ generatePreviewProxies: v });
}

export async function setExportMasters(v: ExportMasters): Promise<void> {
  await updateProjectSettings({ export_masters: v });
  useProxyPrefStore.setState({ exportMasters: v });
}

export async function setCopyMediaOnImport(v: boolean): Promise<void> {
  await updateProjectSettings({ copy_media_on_import: v });
  useProxyPrefStore.setState({ copyMediaOnImport: v });
}

export async function setProxyOverride(mediaId: string, value: boolean | null): Promise<void> {
  await updateProjectSettings({ proxy_override: { media_id: mediaId, value } });
  useProxyPrefStore.setState((s) => {
    const overrides = { ...s.overrides };
    if (value === null) delete overrides[mediaId];
    else overrides[mediaId] = value;
    return { overrides };
  });
}

async function rehydrate(): Promise<void> {
  try {
    const v = await getProjectSettings();
    useProxyPrefStore.getState().hydrate({
      preferProxies: v.prefer_proxies,
      generatePreviewProxies: v.generate_preview_proxies,
      exportMasters: v.export_masters ?? "auto",
      copyMediaOnImport: v.copy_media_on_import ?? true,
      overrides: v.proxy_overrides,
    });
  } catch {
    // No project loaded yet — keep defaults.
  }
}

/** Hydrate on mount and re-hydrate whenever the project summary swaps
 *  (new project / reload). Call once from App.tsx; returns an unsubscribe. */
export function wireProxyPrefStore(): () => void {
  void rehydrate();
  return useProjectStore.subscribe((s, prev) => {
    // Compare project IDENTITY, not the summary object: `projectStore.apply()`
    // installs a brand-new `summary` object on every `project:changed` event
    // (every edit/undo/marker/MCP call), so comparing objects re-hydrates on
    // essentially every commit — a needless IPC round-trip, and a real
    // out-of-order-IPC race where an unrelated edit's in-flight rehydrate()
    // can resolve after a setProxyOverride/setPreferProxies optimistic write
    // and clobber it with a stale settings snapshot.
    if (s.summary?.project_id !== prev.summary?.project_id) void rehydrate();
  });
}
