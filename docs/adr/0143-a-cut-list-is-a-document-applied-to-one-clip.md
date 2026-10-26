---
status: accepted
---

# A cut list is a document applied to one clip

Date: 2026-10-26

## Context

An agent that has read a transcript knows what should stay: these sentences,
not those; these words, not the filler between them. Turning that into an edit
took one `split_layer`, then a `delete_layers { ripple: true }` over the
pieces — or, done range by range, a ripple per range, each measured against a
timeline the previous one had already re-timed, and an undo step for every
one. `remove_pauses` already makes exactly this edit as one commit — cut a list
of ranges out of a clip, its link partners with it, and close the gaps on every
track — but only over the ranges its own detector found, shrunk by a pad.

The surface sits at 94 tools against a ceiling of about 100 (ADR 0074), so a
new tool is first checked against an existing one's arguments.

## Decision

- **One new tool, `apply_cut_list { layer_id, keep | remove }`.** Not a flag on
  `remove_pauses`: that tool's subject is a detection — its parameters are a
  threshold, a minimum length and a pad — and an explicit list would make every
  one of them meaningless in one mode; two tools whose arguments do not overlap
  are not "two verbs differing by a boolean". Not `delete_layers`, which removes
  whole layers. The name follows `apply_transcripts` and `apply_subtitles`: a
  document — here an edit decision list — landed on the timeline.
- **`keep` or `remove`, exactly one.** A transcript-driven cut is naturally
  either ("keep these sentences", "drop these words"); the complement is
  computed here rather than by every agent.
- **Ranges are timeline-absolute and inside the clip** — the space
  `transcribe_clip`, `detect_pauses` and `project://tracks` speak, so a
  transcript's segments go in as they come. A stored transcript read back from
  `media://{id}/transcript` is source-absolute (ADR 0142) and is placed first.
  A range outside the clip is refused, not clamped; overlapping and touching
  ranges merge, because a word-by-word list touches at every word.
- **One planner, one commit.** `remove_pauses`' cut-list planning — interior
  boundaries, discard by midpoint, the frame-grid landing when the clip
  travels with a picture — moved to `mutations/cutList.ts`, and both tools
  call it. The commit is the same `split_layer_multi { discard_segments,
  ripple: true }`, whose recipe moved to `applySplitLayerMulti` so a rehearsal
  can run it.
- **It is the one ripple `dry_run` rehearses.** The `dry_run` op calls the wet
  arm's planner and the same recipe against the clone, so a rehearsal names
  the refusal or the survivors the commit would. `delete_layers { ripple:
  true }` stays refused there.
- **It answers with the committed record**: the surviving segments, the ranges
  removed as landed, the time removed, and what the ripple moved. A list that
  removes nothing records nothing; one that removes the whole clip is refused
  as a delete.
- `destructiveHint: true`, with the removals.

## Consequences

- A rough cut from a transcript is one call and one undo, whatever the number
  of ranges, and it is rehearsable.
- The two cut-and-close tools cannot drift on where a cut lands: there is one
  planner.
- The catalog grows to 95 tools and about 1.5 KB.
- The scope is one clip. A whole-timeline cut list (every track cut at the
  same instants) is not built: tracks under a talking head — music, B-roll —
  rarely want the same cuts, and the ripple refusals already say which layer a
  single-clip cut would disturb.
