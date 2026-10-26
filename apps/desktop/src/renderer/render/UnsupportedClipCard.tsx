// Preview-only overlay shown when the on-screen clip's media resolves to
// `status: "unsupported"` — no decode engine can produce a frame for it (only
// reachable on the Lite/webcodecs engine, or a pinned Standard engine with no
// usable component). `PixiPreview` renders this as an absolute sibling of the
// canvas, driven by `Compositor`'s `onUnsupported` callback.

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { tryMutate } from "../errors/tryMutate";
import { setAppSettings } from "../settings/appSettingsStore";
import { useDecodeComponentStore } from "../settings/decodeComponentStore";
import { generateQuickProxy } from "../ipc";
import { setProxyOverride } from "../state/proxyPreferenceStore";

function bodyKey(reason: string | undefined, componentAvailable: boolean): string {
  if (!componentAvailable) return "settings.decode_unsupported_body_no_component";
  const r = (reason ?? "").toLowerCase();
  if (r.includes("webcodecs") || r.includes("lite")) return "settings.decode_unsupported_body_lite";
  if (r.includes("ffmpeg") || r.includes("standard")) return "settings.decode_unsupported_body_standard";
  return "settings.decode_unsupported_body_generic";
}

export function UnsupportedClipCard({
  mediaId,
  reason,
}: {
  mediaId: string;
  /// The resolver's actual reason. The card used to always blame the Lite
  /// engine, even when the Standard engine was the one that failed or was
  /// missing. Optional so older hosts/tests still render.
  reason?: string | undefined;
}) {
  const { t } = useTranslation();
  const componentAvailable = useDecodeComponentStore((s) => s.available);
  return (
    <div
      className="absolute inset-0 grid place-items-center bg-black/70 text-center text-sm text-white"
      data-testid="unsupported-clip-card"
    >
      <div className="max-w-sm space-y-3 p-4">
        <div className="font-medium">{t("settings.decode_unsupported_title")}</div>
        <div className="text-white/70">
          {t(bodyKey(reason, componentAvailable))}
        </div>
        {reason && (
          <div className="text-xs text-white/45 break-words" data-testid="unsupported-clip-reason">
            {reason}
          </div>
        )}
        <div className="flex justify-center gap-2">
          {componentAvailable && (
            <Button
              variant="secondary"
              onClick={() => {
                void setAppSettings({ decode_engine: "ffmpeg" });
              }}
            >
              {t("settings.decode_unsupported_switch")}
            </Button>
          )}
          <Button
            variant="secondary"
            data-testid="unsupported-generate-proxy"
            onClick={() => {
              void generateQuickProxy(mediaId);
              // Persisted project-settings write: a rejection without this
              // wrap is an unhandled promise rejection.
              void tryMutate(() => setProxyOverride(mediaId, true), "Set proxy mode");
            }}
          >
            {t("settings.decode_unsupported_generate_proxy")}
          </Button>
        </div>
      </div>
    </div>
  );
}
