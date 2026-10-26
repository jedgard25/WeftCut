---
status: accepted
---

# Native export decode uses VideoToolbox on macOS, and resumes a failed hardware session in software at the exact next frame

Date: 2026-10-26

## Context

The native export session (`export_sw`, [ADR 0033](0033-export-decode-joins-the-engine-overlay.md))
decoded in software only — ADR 0033 left hardware readback as
"profiling-gated future work". On macOS, `auto` export routing now sends HEVC,
VP9, 10-bit and ProRes originals to this session instead of building a lossy
H.264 export master at import. So this lane carries 4K HEVC (8- and 10-bit)
and ProRes in practice, and software HEVC decode at 4K is the heaviest CPU
load an export puts on the machine — it competes with the compositor and the
encoder for the same cores.

The preview side already has a VideoToolbox copy-back lane in the shared
decoder (`DecodeAccel::VideoToolbox`, issue #10): the OS media engine decodes,
`av_hwframe_transfer_data` copies the surface back, and one swscale pass packs
it into the same NV12 / I420P10 transport the software lane ships. Two things
stood between that lane and export: export's exactly-once, GOP-exact range
contract (ADR 0033) cannot tolerate a duplicated or skipped frame, and ADR 0033
forbids mid-export fallback because a quality seam is worse than a failed
export.

## Decision

### The lane is chosen automatically, per session, and reported

`LaneStream::open` (`export_sw/lane.rs`) picks the lane when the session opens:

- off macOS, and for codecs outside the VideoToolbox eligibility set (h264,
  hevc, vp9, prores — the preview's `hwEligibleOnLane('videotoolbox')` set),
  the session decodes in software, exactly as before;
- otherwise it opens the source on VideoToolbox and decodes one frame, keeping
  the lane only if the decoder produced a hardware surface (libavcodec's
  silent software fallback counts as a decline) and the hardware stream
  reports the same dimensions, start PTS and colour tags as the software one.
  The probed stream is rewound and becomes the session's decoder;
- a decline that is a capability verdict (a software surface) is cached for
  the format class (`codec::pix_fmt::WxH`) in the registry, so the other
  phase-group sessions of an export do not re-probe it. Transient errors —
  a VideoToolbox session limit, a mid-range failure — are never cached.

There is no user setting: hardware-vs-software stays private to the Standard
engine, as ADR 0030 already says for preview. The open reply carries `lane`
(`videotoolbox` | `software`) and `laneReason`, which main logs per session.
`WEFTCUT_EXPORT_DECODE_LANE=software` pins software for diagnosis; an unknown
value fails the open rather than silently meaning `auto`.

### A hardware failure mid-range resumes in software at the exact next frame

On the VideoToolbox lane, any decode or seek error downgrades the stream,
once and permanently, to a freshly opened software stream positioned on the
exact next frame:

- the stream remembers the PTS `p` of the last frame it handed to the range
  server since the last seek (delivered, skipped as pre-range reference, or
  stashed past `b` — all count, because the range server has consumed them);
- the software stream seeks to the GOP key at or before `p` (with the same
  overshoot retry as every export seek), decodes forward, discards every frame
  at or before `p`, and holds the first frame past it for the next
  `next_frame`;
- with a seek but no frame yet, it repeats the seek so the range server's own
  landing probe sees the same keyframe landing; before any seek, the fresh
  stream is already at the start.

Presentation order is monotonic and both lanes share libavcodec's parser,
reorder and output logic (the hwaccel only replaces slice decoding), so the
frame after `p` is the frame VideoToolbox would have produced. The range
server, credit window and in-band message order are untouched: the downgrade
happens beneath `next_frame`, and the session emits no extra message. The
native session logs the downgrade; if the software re-open itself fails, the
error surfaces in-band as before and the export aborts loudly.

This is the "one same-engine session rebuild" ADR 0033 anticipated, done
inside the session. It is not the cross-engine or cross-source fallback ADR
0033 forbids, because the conformance below shows the two lanes deliver the
same pictures: there is no seam to see.

### Conformance is the license for the lane swap

`export_sw/vt_conformance.rs` (macOS) holds the gates:

- the VideoToolbox lane delivers the software lane's exact sequence (PTS,
  duration, colour tags, dimensions, start PTS) over scripted ranges —
  forward continuations, a forward gap, a backward re-seek into mid-GOP,
  re-entry, and a range through EOS — on open-GOP H.264 and HEVC 8/10-bit
  fixtures with B-frames, plus ProRes;
- injected failures at every third VideoToolbox frame index across that
  script, on the first three seeks, and at the open-time probe all deliver the
  identical sequence;
- per plane, PSNR ≥ 50 dB and max difference ≤ 2 codes (8-bit-equivalent)
  against software.

Measured on an M3 Max (720p, 4 s, B-frames, 4 ranges, 118 frames):

| source | transport | Y / U / V vs software | colour tags |
|---|---|---|---|
| H.264 8-bit | NV12, I420P10 | identical (0 diff) | identical |
| HEVC 8-bit | NV12, I420P10 | identical | identical |
| HEVC Main10 | I420P10 | identical | identical |
| HEVC Main10 | NV12 | Y identical; U/V 54 dB, max 1 code | identical |
| ProRes 422 HQ | I420P10 | 73.8 / 74.4 / 74.4 dB, max 1–2 (10-bit codes) | identical |
| ProRes 422 HQ | NV12 | 67.7 / 68.4 / 68.3 dB, max 1 | identical |

H.264 and HEVC are bit-exactly specified, so the two decoders agree exactly;
the only difference there is swscale's rounding when it narrows 10-bit
chroma to 8-bit from P010 versus yuv420p10. ProRes's IDCT precision is
implementation-defined, so two conformant decoders differ by a code. The
50 dB / 2-code floor sits above [ADR 0014](0014-export-color-perceptual-conformance.md)'s
"faithful" bar for exported colour (about 42 dB, worst channel 2 codes) and
far above any real defect (a range or matrix error scores under 30 dB).

## Considered options

- **A user-visible export lane setting.** Rejected: preview does not expose
  its hardware lane either; the choice is machine capability, made per session
  and logged.
- **Consult main's persisted machine capability cache before opening.**
  Rejected for now: it needs a format-class key the export path does not have
  without an extra probe, and the in-session probe costs one frame on a stream
  that is then reused. The registry-scoped negative cache covers the repeated
  sessions of one export.
- **Fail the export on a hardware error (ADR 0033's posture).** Rejected:
  VideoToolbox sessions are a finite OS resource, and an export that loses one
  mid-run would fail for no fidelity reason.
- **Restart the whole range in software.** Rejected: the range server has
  already emitted frames; re-emitting them breaks exactly-once delivery.
- **NVDEC / VAAPI for export.** Not done: no conformance evidence on those
  lanes for export, and Linux/NVIDIA preview evidence (opaque frames) argues
  for caution. Non-macOS export decode is unchanged.

## Consequences

- 4K HEVC export decode on an M3 Max over ~20 s (600 frames), through the
  export session, software at the production thread budget (4) vs
  VideoToolbox: 8-bit NV12 22.7 s user CPU at 79 fps vs 0.7 s user (+0.7 s
  in the VideoToolbox service) at 119 fps; 10-bit I420P10 26.7 s at 68 fps vs
  4.5 s (+0.4 s) at 91 fps. With all 14 cores, software is faster in wall
  time (146 / 132 fps) at the same CPU cost. The 10-bit lane's remaining CPU
  is the single-threaded P010 → I420P10 swscale pack on the session thread.
- The export Worker, the IPC transport and the range contract are unchanged;
  the reply gains `lane` / `laneReason`.
- A mid-range downgrade is visible only in the main-process log; the export's
  perf payload does not yet count hardware-lane sessions, so an e2e gate
  cannot assert the lane.
- Hosted macOS runners can decline ProRes on VideoToolbox; the ProRes gate
  then compares software with software and still passes.
