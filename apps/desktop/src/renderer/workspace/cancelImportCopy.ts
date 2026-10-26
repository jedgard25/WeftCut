import { importCancel, setMediaExternal } from "../ipc";

/// The media pool's "Cancel copy and leave the file where it is". Native
/// cancels the running or queued copy; marking the item external is what makes
/// that durable, since reopening re-queues the copy of every item that still
/// has no workspace path. Only when the cancel took hold: a copy that already
/// landed owns the file, and `set_media_external` would refuse it anyway.
export async function cancelImportCopy(mediaId: string): Promise<void> {
  const cancelled = await importCancel(mediaId).catch(() => false);
  if (!cancelled) return;
  await setMediaExternal(mediaId, true).catch((error) => {
    console.warn("marking cancelled import external failed:", error);
  });
}
