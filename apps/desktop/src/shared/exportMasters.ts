// When a source's full export master is built — `ProjectSettings.export_masters`,
// mirrored by Rust `state::ExportMasters`. Shared because BOTH sides resolve
// it: main hands the job layer the effective answer (`ProxyPolicy`), and the
// renderer's import sweep must agree with it before route-correcting a source.
// See docs/preview.md §Proxies.

/// `auto`: build at import only when the native export decoder is unavailable
/// (with it, export decodes the original — `exportDecodeRouting.ts`).
/// `on_import`: always build at import (upstream's behaviour).
/// `on_demand`: never at import; the export gate builds it if the export
/// cannot read the original.
export type ExportMasters = "auto" | "on_import" | "on_demand";

export const EXPORT_MASTERS: readonly ExportMasters[] = ["auto", "on_import", "on_demand"];

export function isExportMasters(v: unknown): v is ExportMasters {
  return typeof v === "string" && (EXPORT_MASTERS as readonly string[]).includes(v);
}

/// Whether the import/open fan-out builds masters now.
export function buildsMastersOnImport(setting: ExportMasters, nativeDecodeAvailable: boolean): boolean {
  switch (setting) {
    case "on_import": return true;
    case "on_demand": return false;
    case "auto": return !nativeDecodeAvailable;
  }
}
