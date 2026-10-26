---
status: accepted
---

# A transcript is kept per source, and read back under every view

Date: 2026-10-26

## Context

`transcribe_clip` answered every call by extracting the window's audio and
running the engine again. The extracted WAV was content-addressed
(`transcribe-audio/`), so a repeat saved one ffmpeg run, but the engine — a
local model that takes most of a minute on a long take, or a cloud upload that
bills — ran every time. And nothing an engine heard outlived the call: an agent
in a later session that wanted the words of an interview already captioned had
no way to read them but to transcribe again. Since `c4ef24b4` the envelope is
exactly the transcript and nothing else, so there was no second copy anywhere.

Scene description already solved the same problem (ADR 0122): a range-lazy
cache keyed by source content and the view, a fast path that spawns no model
for a covered window, and a `media://{id}/description` resource that never
runs inference on a miss. Its resource resolves ONE key, because every axis of
a description's view — engine, sampling, focus, language — is an app setting
the host can inject into a URI read.

A transcript's view is not. Its axes are the call's own arguments: which
engine (`backend`, else the preference), the language hint, whether exact
word times were asked for. Two calls on the same source with different hints
are both legitimate, and no URI carries either hint.

## Decision

- **The store is per source, keyed like a description.** Each entry is
  `Cache/transcripts/<source_hash>/<key>.json`, `key = blake3(version,
  source_hash, backend, model, language_hint, word_timestamps)`. `model` is the
  cloud model name or a local model file's path, size and mtime (FunASR's
  tokens too), so new weights behind one path are a new entry. The language
  hint is in the key because a wrong auto-detect is exactly why a caller
  retries with one; `auto` names its absence.
- **Times are stored source-absolute** and placed per call through the layer's
  rate and offset, so one entry serves every layer on the source.
- **A covered window answers with no extraction and no engine**, and the
  envelope says `cached: true`. `normalize_audio: true` never answers from the
  store — it is the explicit "hear it again, louder" request — but what it
  hears replaces the window.
- **Membership is by midpoint.** A segment belongs to the window holding its
  midpoint and is clamped to it; a merge replaces the stored segments whose
  midpoint the new window holds. A segment is a sentence, and a window edge
  must not cut one in half.
- **The resource lists every entry of the source.** `media://{id}/transcript`
  answers `{ media_id, time_basis: "source", transcripts: [...] }`, newest
  first, each entry labelled with its own view; `404` naming `transcribe_clip`
  when there is none, and it never runs speech. `read_project { view:
  "media_transcript" }` serves the same JSON to a client without resources.
- **A failed write does not fail the call.** The transcript was heard and
  maybe billed; losing the store costs the next call an engine run, not this
  one its answer.
- The store is outside the disk-LRU sweep, with `descriptions/`: evicting it
  re-pays an engine run.

## Consequences

- Re-transcribing a clip, or captioning a second layer cut from the same take,
  costs nothing once its window has been heard.
- A later session reads what was said without configuring an engine at all.
- An agent reading the resource chooses among entries itself — usually the
  newest, or the one whose `language_hint` it wants. That is the price of not
  inventing a "current" transcript the request arguments never named.
- A window only partly heard runs the engine over the whole window, not just
  the unheard part: `covers` asks for one merged range, as the description
  cache does. Touching windows merge, so transcribing a whole layer once makes
  every window inside it a hit.
- No re-segmentation option rides the tool: `apply_transcripts` builds cues to
  the style's caption limits and `correct_caption_text` re-segments by word
  timing, which is that job done where the style is known.
