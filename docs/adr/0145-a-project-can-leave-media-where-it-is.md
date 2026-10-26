---
status: accepted
---

# A project can leave media where it is

Date: 2026-10-26

## Context

Import has always copied every original into `<workspace>/Media/`
([ADR 0102](0102-import-work-belongs-to-a-workspace-session.md)), so the project
folder is self-contained. That costs disk and time for large footage that already
sits on a fast, stable volume, and Final Cut Pro lets the user choose between
"Copy to library" and "Leave files in place".

Two states shared one representation, `path_rel === null`: a copy still pending,
and a synthesized `Cache/` item. Reopening re-queued the copy of every such item
(`recoverInterruptedImports`), so even the media pool's "Cancel copy and keep the
original reference" lasted only until the next open.

## Decision

`ProjectSettings.copy_media_on_import` (default `true`, upstream's behaviour) is
a per-project setting under Settings > Project > Import. When it is off, an
imported file is not copied: its item gets `path_rel: null` and a new
`MediaItem.external: true`, its absolute `path_abs` stays authoritative, and it
is hashed in place with the same standalone pass a copying import uses, so
derivative caches keep their content-addressed keys and every job runs against
the original. All entry points (picker, drop, MCP `import_media`) pass through the
one `import_media` hybrid, which follows the project setting; the MCP tool has no
per-call override. An SVG's rasterized PNG is copied regardless (it is our file, in
the app cache), and synthesized `Cache/` media never passes through import.

`external` is the durable marker rather than a second setting read at recovery
time, because the setting can change after an import and the cancel action needs
somewhere to record its answer. It is a plain boolean beside `path_rel` (serde
default `false`; `parseProject` backfills it), not a variant of a path enum:
`path_rel`'s only readers want "is the workspace anchor present", and `external`
only has to say why it is absent. `recoverInterruptedImports` skips external items
for the copy (it still completes an interrupted hash), and the pool's cancel
action sets `external` through the unrecorded `set_media_external` after a
successful native cancel, refused once the copy has landed.

A missing external file shows the existing missing badge, and the pool menu offers
*Locate…*. The chosen file is hashed and must equal `file_hash_blake3`; the
actor then re-points `path_abs` as one recorded edit (`relink_media`). A mismatch
is refused rather than overridable: the item's derivatives, transcripts and
analysis are keyed on the hash, so adopting different bytes under the same id
would serve stale results silently. A different file is imported as new media.
This is stricter than the "warn and continue" alternative and consistent with
`relinkMissingMedia`, which also relinks by content only.

## Consequences

- The project folder is no longer self-contained when the setting is off.
  Zipping or moving it, or opening it on another machine, needs the originals at
  the same absolute paths; otherwise they show as missing until located. The
  setting's hint says so.
- Changing the setting affects later imports only. Existing items keep what they
  have; there is no bulk "copy everything in" or "move out" action, and no
  per-item *Copy into project* yet (a cancelled copy cannot be resumed short of
  re-importing).
- Relinking by content automatically (`relinkMissingMedia`) still applies to
  project-owned media only. An external item whose file is renamed in place is
  found again only through *Locate…*.
- Edit-time risk moves to the user's volume: an external file on a disconnected
  drive blocks playback and export of its clips, as it would in any NLE.
