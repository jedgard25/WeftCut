//! Export-decode lane selection: the VideoToolbox copy-back lane on macOS, the
//! software lane everywhere, and the mid-stream downgrade between them.
//!
//! Owns: [`LaneStream`] — a [`SwVideoStream`] on a chosen lane that keeps the
//! export session's `seek` / `next_frame` contract across a hardware failure by
//! re-opening the source in software and resuming at the exact next frame; the
//! open-time lane choice (eligibility, one-frame hardware probe, the per-registry
//! negative verdict cache) and its recorded reason; [`robust_seek_and_probe`],
//! shared by the range server and the resume path.
//!
//! Does NOT own: the decoder or the copy-back conversion (that is
//! `preview_sw::decoder`, the same path the preview's VideoToolbox lane uses), nor
//! range coverage / credits (`session::serve_range`). See ADR 0144.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use ffmpeg_next::format::Pixel;

use crate::preview_sw::decoder::{
    DecodeAccel, OutScale, SwColorTags, SwFrame, SwOutFormat, SwVideoStream,
};
use crate::recover::LockExt;

/// Largest number of backward re-seek attempts when a container's seek overshoots
/// the target. Index-less MPEG-PS/TS estimate the seek byte-offset and can land
/// AFTER the requested time; each retry steps the target back by a growing
/// margin. The final fallback (seek target 0) decodes from the start — always a
/// valid at-or-before landing. Mirrors `preview_sw::session::serve_request`.
const MAX_SEEK_RETRIES: u32 = 6;
/// Initial backward step when re-seeking after an overshoot; doubles each retry.
const SEEK_RETRY_MARGIN_US: i64 = 1_000_000;

/// The two operations the range server and the resume path drive a stream with.
/// Implemented by the raw [`SwVideoStream`] (the resume path's fresh software
/// stream) and by [`LaneStream`] (the session's stream).
pub(crate) trait FrameSource {
    fn seek(&mut self, target_us: i64) -> Result<(), String>;
    fn next_frame(&mut self) -> Result<Option<SwFrame>, String>;
}

impl FrameSource for SwVideoStream {
    fn seek(&mut self, target_us: i64) -> Result<(), String> {
        SwVideoStream::seek(self, target_us)
    }
    fn next_frame(&mut self) -> Result<Option<SwFrame>, String> {
        SwVideoStream::next_frame(self)
    }
}

/// Robust seek: land on a keyframe AT/BEFORE `target_us` and return the first
/// decoded frame there — the initial candidate for a forward scan. `Ok(None)`
/// means the seek landed at EOF. See [`MAX_SEEK_RETRIES`] for why an overshoot
/// is retried. Mirrors `preview_sw`'s inline retry.
pub(crate) fn robust_seek_and_probe<S: FrameSource>(
    stream: &mut S,
    target_us: i64,
) -> Result<Option<SwFrame>, String> {
    let mut seek_target = target_us;
    let mut margin = SEEK_RETRY_MARGIN_US;
    let mut attempt = 0u32;
    loop {
        stream
            .seek(seek_target)
            .map_err(|e| format!("seek to {seek_target}us failed: {e}"))?;
        match stream.next_frame()? {
            Some(f) => {
                if f.pts_us > target_us && seek_target > 0 && attempt < MAX_SEEK_RETRIES {
                    seek_target = (target_us - margin).max(0);
                    margin = margin.saturating_mul(2);
                    attempt += 1;
                    continue;
                }
                return Ok(Some(f)); // landed at/before target (or can't retry further)
            }
            None => return Ok(None),
        }
    }
}

/// What the caller asked for. `Auto` is the product default: VideoToolbox when
/// this machine confirms it for the source's format class, else software.
/// `Software` pins the software lane (the `WEFTCUT_EXPORT_DECODE_LANE=software`
/// diagnostic escape hatch, and the conformance reference).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExportLanePolicy {
    #[default]
    Auto,
    Software,
}

impl ExportLanePolicy {
    /// Absent / `"auto"` → `Auto`; `"software"` → `Software`. Anything else is an
    /// error naming the value, so a typo in the escape hatch fails the open loudly
    /// instead of silently meaning `auto`.
    pub fn parse(s: Option<&str>) -> Result<Self, String> {
        match s.map(str::to_ascii_lowercase).as_deref() {
            None | Some("") | Some("auto") => Ok(ExportLanePolicy::Auto),
            Some("software") => Ok(ExportLanePolicy::Software),
            Some(other) => Err(format!("unsupported export decode lane '{other}'")),
        }
    }
}

/// The lane a session is decoding on right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportLane {
    Software,
    VideoToolbox,
}

impl ExportLane {
    /// The name JS sees — the same vocabulary as the preview lanes
    /// (`capabilities()`), with the software lane spelled `software`.
    pub fn wire_name(self) -> &'static str {
        match self {
            ExportLane::Software => "software",
            ExportLane::VideoToolbox => "videotoolbox",
        }
    }
}

/// Format classes VideoToolbox declined on this machine (the decoder produced a
/// software surface instead of a hardware one). Shared by every session of one
/// registry, so a class the OS engine cannot decode is probed once, not once per
/// phase-group session. Holds only capability verdicts — a transient error (VT
/// session exhaustion, a mid-range failure) is never cached.
pub(crate) type DeclinedClasses = Arc<Mutex<HashSet<String>>>;

/// Test-only fault injection: makes the VideoToolbox lane fail at a chosen point
/// so the fallback paths are exercised on a machine where VT works. Production
/// opens always pass `FaultPlan::default()` (no faults).
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct FaultPlan {
    /// The open-time hardware probe fails (as if VT refused the session).
    pub fail_probe: bool,
    /// `next_frame` on the VT lane errors once this many VT frames were decoded.
    pub fail_after_vt_frames: Option<u64>,
    /// The Nth (1-based) seek on the VT lane errors.
    pub fail_vt_seek: Option<u32>,
}

/// The codecs the VideoToolbox lane is allowed to carry — the same set as the
/// preview's `hwEligibleOnLane('videotoolbox', …)` (`shared/hwLaneEligibility.ts`):
/// the interframe trio plus ProRes, any bit depth. The probe still decides.
fn videotoolbox_eligible(codec: &str) -> bool {
    matches!(codec, "h264" | "hevc" | "vp9" | "prores")
}

/// Why VideoToolbox was not used: the reason, and whether it is a capability
/// verdict worth caching for the format class.
struct Decline {
    reason: String,
    capability: bool,
}

/// Open `path` on VideoToolbox and decode one frame to confirm the OS engine
/// really engaged (a hardware surface, not the decoder's silent software
/// fallback) — the export twin of `probe_hw_first_frame`, except the stream is
/// kept: it is rewound to the start and becomes the session's decoder.
fn open_videotoolbox(
    path: &str,
    out_format: SwOutFormat,
    reference: &SwVideoStream,
    fault: &FaultPlan,
) -> Result<SwVideoStream, Decline> {
    let transient = |reason: String| Decline {
        reason,
        capability: false,
    };
    if fault.fail_probe {
        return Err(transient("injected videotoolbox probe failure".into()));
    }
    let mut stream =
        SwVideoStream::open_with_accel(path, out_format, DecodeAccel::VideoToolbox, OutScale::FULL)
            .map_err(transient)?;
    match stream.decode_one_raw_format().map_err(transient)? {
        Some(Pixel::VIDEOTOOLBOX) => {}
        Some(fmt) => {
            return Err(Decline {
                reason: format!("decoder produced {fmt:?}, not a hardware surface"),
                capability: true,
            })
        }
        None => return Err(transient("no frame decoded".into())),
    }
    // Both lanes must describe the same stream, or a mid-range downgrade could
    // not resume on identical timestamps / dimensions / colour tags.
    if (
        stream.width,
        stream.height,
        stream.start_pts_us,
        &stream.color,
    ) != (
        reference.width,
        reference.height,
        reference.start_pts_us,
        &reference.color,
    ) {
        return Err(transient(
            "videotoolbox stream metadata differs from software".into(),
        ));
    }
    stream.seek(0).map_err(transient)?;
    Ok(stream)
}

/// A session's decode stream on its chosen lane. On the VideoToolbox lane any
/// decode or seek error downgrades it — once, permanently — to a fresh software
/// stream positioned so the next `next_frame` returns exactly the frame the
/// hardware stream would have returned next: no duplicate, no gap.
pub(crate) struct LaneStream {
    stream: SwVideoStream,
    lane: ExportLane,
    path: String,
    out_format: SwOutFormat,
    /// Target of the most recent `seek` (None: never seeked since open).
    seek_anchor_us: Option<i64>,
    /// PTS of the last frame handed out since that seek (None: none yet). The
    /// resume point: everything at or before it was already delivered upstream.
    last_yielded_us: Option<i64>,
    /// The first frame past `last_yielded_us`, decoded by the software resume and
    /// handed out on the next `next_frame`.
    resumed: Option<SwFrame>,
    /// Frames decoded on the VT lane (fault-injection clock).
    vt_frames: u64,
    /// Seeks issued on the VT lane (fault-injection clock).
    vt_seeks: u32,
    /// Mid-stream downgrades this stream took (0 or 1).
    pub fallbacks: u32,
    fault: FaultPlan,
    pub width: u32,
    pub height: u32,
    pub color: SwColorTags,
    pub start_pts_us: i64,
}

/// The open-time lane decision, reported back to the caller.
#[derive(Debug, Clone)]
pub struct LaneChoice {
    pub lane: ExportLane,
    pub reason: String,
}

impl LaneStream {
    /// Open `path` packing into `out_format`, choosing the lane per `policy`.
    /// The software stream opens first (cheap: no decode) — it names the format
    /// class and is the fallback when VideoToolbox is ineligible, previously
    /// declined, or fails its one-frame probe. Off macOS this is always software.
    pub(crate) fn open(
        path: &str,
        out_format: SwOutFormat,
        policy: ExportLanePolicy,
        declined: &DeclinedClasses,
        fault: FaultPlan,
    ) -> Result<(LaneStream, LaneChoice), String> {
        let sw = SwVideoStream::open_with_accel(
            path,
            out_format,
            DecodeAccel::Software,
            OutScale::FULL,
        )?;
        let (codec, pix_fmt, w, h) = sw.probe_identity();
        let class = format!("{codec}::{pix_fmt}::{w}x{h}");

        let software = |reason: String| (ExportLane::Software, reason);
        let (stream, (lane, reason)) = if policy == ExportLanePolicy::Software {
            (sw, software("software lane requested".into()))
        } else if !cfg!(target_os = "macos") {
            (
                sw,
                software("no hardware export lane on this platform".into()),
            )
        } else if !videotoolbox_eligible(&codec) {
            (
                sw,
                software(format!("{codec} is not videotoolbox-eligible")),
            )
        } else if declined.lock_recover().contains(&class) {
            (
                sw,
                software(format!("videotoolbox declined {class} earlier")),
            )
        } else {
            match open_videotoolbox(path, out_format, &sw, &fault) {
                Ok(vt) => (
                    vt,
                    (
                        ExportLane::VideoToolbox,
                        format!("videotoolbox confirmed a hardware surface for {class}"),
                    ),
                ),
                Err(d) => {
                    if d.capability {
                        declined.lock_recover().insert(class);
                    }
                    (
                        sw,
                        software(format!("videotoolbox unavailable: {}", d.reason)),
                    )
                }
            }
        };

        let ls = LaneStream {
            width: stream.width,
            height: stream.height,
            color: stream.color.clone(),
            start_pts_us: stream.start_pts_us,
            stream,
            lane,
            path: path.to_string(),
            out_format,
            seek_anchor_us: None,
            last_yielded_us: None,
            resumed: None,
            vt_frames: 0,
            vt_seeks: 0,
            fallbacks: 0,
            fault,
        };
        Ok((ls, LaneChoice { lane, reason }))
    }

    /// Replace the VideoToolbox stream with a software one positioned so the next
    /// `next_frame` yields exactly the frame after the last one handed out:
    ///
    /// - a frame was handed out since the last seek (PTS `p`): seek the software
    ///   stream to the GOP key at/before `p` (overshoot-retried), decode forward,
    ///   discard every frame at or before `p`, and hold the first one past it.
    ///   Presentation order is monotonic and both lanes share libavcodec's
    ///   reorder/output logic, so that is the frame VT would have produced next;
    /// - a seek but no frame yet: repeat the seek, so the caller's own probe of
    ///   the landing frame sees the same keyframe landing;
    /// - neither: the fresh stream is already at the start.
    fn fall_back_to_software(&mut self, cause: &str) -> Result<(), String> {
        let fail =
            |e: String| format!("videotoolbox failed ({cause}); software re-open failed: {e}");
        let mut sw = SwVideoStream::open_with_accel(
            &self.path,
            self.out_format,
            DecodeAccel::Software,
            OutScale::FULL,
        )
        .map_err(fail)?;
        if (sw.width, sw.height, sw.start_pts_us) != (self.width, self.height, self.start_pts_us) {
            return Err(fail("software stream metadata differs".into()));
        }
        match (self.last_yielded_us, self.seek_anchor_us) {
            (Some(p), _) => {
                let mut candidate = robust_seek_and_probe(&mut sw, p).map_err(fail)?;
                while let Some(f) = candidate {
                    if f.pts_us > p {
                        self.resumed = Some(f);
                        break;
                    }
                    candidate = sw.next_frame().map_err(fail)?;
                }
            }
            (None, Some(t)) => sw.seek(t).map_err(fail)?,
            (None, None) => {}
        }
        eprintln!(
            "[export-sw] {}: videotoolbox failed ({cause}); resumed in software after {}",
            self.path,
            self.last_yielded_us
                .map_or("the last seek".to_string(), |p| format!("pts {p}us")),
        );
        self.stream = sw;
        self.lane = ExportLane::Software;
        self.fallbacks += 1;
        Ok(())
    }
}

impl FrameSource for LaneStream {
    fn seek(&mut self, target_us: i64) -> Result<(), String> {
        self.resumed = None;
        self.last_yielded_us = None;
        self.seek_anchor_us = Some(target_us);
        if self.lane != ExportLane::VideoToolbox {
            return self.stream.seek(target_us);
        }
        self.vt_seeks += 1;
        let result = if self.fault.fail_vt_seek == Some(self.vt_seeks) {
            Err("injected videotoolbox seek failure".to_string())
        } else {
            self.stream.seek(target_us)
        };
        match result {
            Ok(()) => Ok(()),
            Err(e) => self.fall_back_to_software(&e),
        }
    }

    fn next_frame(&mut self) -> Result<Option<SwFrame>, String> {
        if let Some(f) = self.resumed.take() {
            self.last_yielded_us = Some(f.pts_us);
            return Ok(Some(f));
        }
        let on_vt = self.lane == ExportLane::VideoToolbox;
        let result = if on_vt && self.fault.fail_after_vt_frames == Some(self.vt_frames) {
            Err("injected videotoolbox decode failure".to_string())
        } else {
            self.stream.next_frame()
        };
        match result {
            Ok(Some(f)) => {
                if on_vt {
                    self.vt_frames += 1;
                }
                self.last_yielded_us = Some(f.pts_us);
                Ok(Some(f))
            }
            Ok(None) => Ok(None),
            Err(e) if on_vt => {
                self.fall_back_to_software(&e)?;
                self.next_frame()
            }
            Err(e) => Err(e),
        }
    }
}
