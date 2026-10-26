//! Conformance of the export session's VideoToolbox lane against its software
//! lane (ADR 0144), macOS only — VideoToolbox is an OS framework on every
//! supported Mac, so these run on any macOS host (CI runs them serially, see
//! `docs/agents/testing.md`).
//!
//! Always-on gates (committed tiny fixtures, B-frame / multi-GOP sources):
//! - the VT lane delivers the SAME frame sequence (PTS, duration, colour tags)
//!   as the software lane over a scripted list of ranges — forward
//!   continuations, a forward gap, a backward re-seek into mid-GOP, and a range
//!   through EOS — and its pixels stay within [`PSNR_FLOOR_DB`] /
//!   [`MAX_ABS_DIFF`] per plane;
//! - a VT failure at open, at every frame index of a scripted run, and on a
//!   seek resumes in software with the identical exactly-once sequence.
//!
//! On demand (`#[ignore]`, generate media with the bundled GPL ffmpeg sidecar
//! into a temp dir):
//!
//! ```text
//! cargo test --manifest-path native/decode/Cargo.toml --features test-noop \
//!   vt_conformance -- --ignored --nocapture --test-threads=1
//! ```
//!
//! - `conformance_report`: 1280x720 H.264 8-bit, HEVC 8-bit, HEVC Main10 and
//!   ProRes 422 HQ — the per-plane PSNR / max-diff / colour-tag table;
//! - `bench_export_decode_cpu`: ~20 s 4K HEVC 8- and 10-bit through the
//!   export session on each lane — wall clock, process user/system CPU, and the
//!   CPU VideoToolbox's out-of-process decoder service burned.
//!
//! Fixtures `tiny_{h264,hevc8,hevc10}_bframes.mp4`: 192x144, 30 fps, 60 frames,
//! 15-frame GOPs with 3 B-frames (H.264 open-GOP), BT.709 limited-range tags,
//! generated with the bundled sidecar (`resources/ffmpeg/mac/ffmpeg`):
//!
//! ```text
//! T="-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709"
//! V=colorprim=bt709:transfer=bt709:colormatrix=bt709
//! S="-f lavfi -i testsrc2=size=192x144:rate=30:duration=2 -an"
//! ffmpeg $S -c:v libx264 -profile:v high -pix_fmt yuv420p -g 15 -bf 3 \
//!   -x264-params open-gop=1:$V -crf 30 $T tiny_h264_bframes.mp4
//! ffmpeg $S -c:v libx265 -profile:v main -pix_fmt yuv420p -crf 30 -tag:v hvc1 \
//!   -x265-params keyint=15:min-keyint=15:bframes=3:$V $T tiny_hevc8_bframes.mp4
//! ffmpeg $S -c:v libx265 -profile:v main10 -pix_fmt yuv420p10le -crf 30 -tag:v hvc1 \
//!   -x265-params keyint=15:min-keyint=15:bframes=3:$V $T tiny_hevc10_bframes.mp4
//! ```

use super::lane::{ExportLanePolicy, FaultPlan};
use super::session::{ExportOpenOptions, ExportPoke, ExportSwOpenInfo, ExportSwRegistry};
use crate::preview_sw::decoder::{SwColorTags, SwOutFormat};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Per-plane fidelity floor of the VT lane vs the software lane, on the plane's
/// own code scale (255 at 8-bit, 1023 at 10-bit). H.264 and HEVC are
/// bit-exactly specified decoders, so the measured difference is 0 (identical
/// bytes); ProRes is a DCT codec whose IDCT precision is implementation-defined,
/// so two conformant decoders may differ by a code or two. 50 dB is well above
/// ADR 0014's "faithful" export bar (≈42 dB / worst channel 2 codes on the
/// displayed RGB) and far below any real defect (a range or matrix error scores
/// under 30 dB) — a lane swap mid-export can therefore never be a visible seam.
const PSNR_FLOOR_DB: f64 = 50.0;
/// Largest per-sample difference tolerated, in 8-bit-equivalent codes (×4 on a
/// 10-bit plane). See [`PSNR_FLOOR_DB`].
const MAX_ABS_DIFF: u32 = 2;

fn fixture(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// One delivered frame, as the export Worker would receive it.
#[derive(Clone)]
struct Got {
    pts: i64,
    dur: i64,
    color: SwColorTags,
    format: SwOutFormat,
    w: u32,
    h: u32,
    data: Vec<u8>,
}

#[derive(Default)]
struct Sink {
    frames: Vec<Got>,
    markers: usize,
    errors: Vec<String>,
}

struct Run {
    info: ExportSwOpenInfo,
    frames: Vec<Got>,
}

/// Open a session with `options`, drive `ranges` in order (returning credits
/// generously), and collect every frame. Panics on any in-band error.
fn run(path: &str, fmt: &str, options: ExportOpenOptions, ranges: &[(i64, i64)]) -> Run {
    let got = Arc::new(Mutex::new(Sink::default()));
    let g2 = got.clone();
    let reg = ExportSwRegistry::new();
    reg.set_sink(Box::new(move |poke| {
        let mut s = g2.lock().unwrap();
        match poke {
            ExportPoke::Frame { frame, .. } => s.frames.push(Got {
                pts: frame.pts_us,
                dur: frame.dur_us,
                color: frame.color,
                format: frame.format,
                w: frame.width,
                h: frame.height,
                data: frame.data,
            }),
            ExportPoke::RangeEnd { .. } => s.markers += 1,
            ExportPoke::Ended { .. } => {}
            ExportPoke::Error { message, .. } => {
                s.errors.push(message);
                s.markers += 1;
            }
        }
    }));
    let info = reg
        .open_with_options("c", path, fmt, 6, options)
        .unwrap_or_else(|e| panic!("open {path}: {e}"));
    for &(a, b) in ranges {
        let before = got.lock().unwrap().markers;
        reg.decode_range("c", a, b).unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            reg.return_credit("c", 64).unwrap();
            if got.lock().unwrap().markers > before {
                break;
            }
            assert!(Instant::now() < deadline, "range [{a}, {b}] timed out");
            thread::sleep(Duration::from_millis(1));
        }
    }
    reg.close("c").unwrap();
    drop(reg); // releases the sink closure's clone of `got`
    let s = Arc::try_unwrap(got).ok().unwrap().into_inner().unwrap();
    assert!(s.errors.is_empty(), "{path}: in-band errors {:?}", s.errors);
    Run {
        info,
        frames: s.frames,
    }
}

fn software() -> ExportOpenOptions {
    ExportOpenOptions {
        policy: ExportLanePolicy::Software,
        fault: FaultPlan::default(),
    }
}

fn auto(fault: FaultPlan) -> ExportOpenOptions {
    ExportOpenOptions {
        policy: ExportLanePolicy::Auto,
        fault,
    }
}

/// The scripted range list for a ~2 s, 30 fps, 15-frame-GOP fixture: two
/// contiguous forward ranges, a forward range after a gap (mid-GOP entry by
/// decode-through), a backward re-seek into the middle of the second GOP, a
/// re-seek into mid-GOP after it, and a range running through EOS.
const RANGES: &[(i64, i64)] = &[
    (0, 400_000),
    (400_001, 900_000),
    (1_050_000, 1_300_000),
    (650_000, 800_000),
    (820_000, 1_000_000),
    (1_700_000, 10_000_000),
];

/// Per-plane comparison of two packed frames.
#[derive(Debug, Clone, Copy)]
struct PlaneStat {
    psnr_db: f64,
    /// Max absolute difference in the plane's own codes.
    max_diff: u32,
    peak: u32,
}

/// Split a packed frame into (Y, U, V) sample vectors (NV12's interleaved UV
/// de-interleaved) with the plane peak.
fn planes(f: &Got) -> (Vec<Vec<u32>>, u32) {
    let (w, h) = (f.w as usize, f.h as usize);
    match f.format {
        SwOutFormat::Nv12 => {
            let y = f.data[..w * h].iter().map(|&v| v as u32).collect();
            let uv = &f.data[w * h..];
            let u = uv.iter().step_by(2).map(|&v| v as u32).collect();
            let v = uv.iter().skip(1).step_by(2).map(|&v| v as u32).collect();
            (vec![y, u, v], 255)
        }
        SwOutFormat::I420p10 => {
            let s: Vec<u32> = f
                .data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u16::from_le_bytes(*p) as u32)
                .collect();
            let (cw, ch) = (w >> 1, h >> 1);
            let y = s[..w * h].to_vec();
            let u = s[w * h..w * h + cw * ch].to_vec();
            let v = s[w * h + cw * ch..].to_vec();
            (vec![y, u, v], 1023)
        }
    }
}

/// Accumulated per-plane error over many frames (PSNR over the whole run's MSE).
#[derive(Default, Clone, Copy)]
struct Acc {
    sq: f64,
    n: u64,
    max: u32,
    peak: u32,
}

impl Acc {
    fn stat(&self) -> PlaneStat {
        let mse = self.sq / self.n.max(1) as f64;
        let psnr_db = if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * ((self.peak as f64).powi(2) / mse).log10()
        };
        PlaneStat {
            psnr_db,
            max_diff: self.max,
            peak: self.peak,
        }
    }
}

fn accumulate(acc: &mut [Acc; 3], a: &Got, b: &Got) {
    assert_eq!((a.w, a.h, a.format), (b.w, b.h, b.format));
    assert_eq!(a.data.len(), b.data.len());
    let (pa, peak) = planes(a);
    let (pb, _) = planes(b);
    for i in 0..3 {
        acc[i].peak = peak;
        for (&x, &y) in pa[i].iter().zip(&pb[i]) {
            let d = x.abs_diff(y);
            acc[i].max = acc[i].max.max(d);
            acc[i].sq += (d as f64) * (d as f64);
            acc[i].n += 1;
        }
    }
}

/// Assert two runs are the same exactly-once sequence (PTS, duration, colour
/// tags, shape) and return the per-plane pixel stats between them.
fn compare(label: &str, reference: &Run, candidate: &Run) -> [PlaneStat; 3] {
    let rp: Vec<i64> = reference.frames.iter().map(|f| f.pts).collect();
    let cp: Vec<i64> = candidate.frames.iter().map(|f| f.pts).collect();
    assert_eq!(cp, rp, "{label}: frame sequence differs from software");
    for (r, c) in reference.frames.iter().zip(&candidate.frames) {
        assert_eq!(c.dur, r.dur, "{label}: duration at {}", r.pts);
        assert_eq!(c.color, r.color, "{label}: colour tags at {}", r.pts);
    }
    assert_eq!(
        (
            candidate.info.width,
            candidate.info.height,
            candidate.info.start_pts_us,
            &candidate.info.color
        ),
        (
            reference.info.width,
            reference.info.height,
            reference.info.start_pts_us,
            &reference.info.color
        ),
        "{label}: open info differs"
    );
    let mut acc = [Acc::default(); 3];
    for (r, c) in reference.frames.iter().zip(&candidate.frames) {
        accumulate(&mut acc, r, c);
    }
    [acc[0].stat(), acc[1].stat(), acc[2].stat()]
}

fn assert_faithful(label: &str, stats: &[PlaneStat; 3]) {
    for (name, s) in ["Y", "U", "V"].iter().zip(stats) {
        let tolerance = MAX_ABS_DIFF * (s.peak + 1) / 256;
        assert!(
            s.psnr_db >= PSNR_FLOOR_DB && s.max_diff <= tolerance,
            "{label} plane {name}: PSNR {:.2} dB, max diff {} (floor {PSNR_FLOOR_DB} dB, ≤{tolerance})",
            s.psnr_db,
            s.max_diff
        );
    }
}

/// Fixtures whose class VideoToolbox decodes on every supported Mac, with the
/// transport formats exercised for each.
const INTERFRAME: &[(&str, &str)] = &[
    ("tiny_h264_bframes.mp4", "NV12"),
    ("tiny_h264_bframes.mp4", "I420P10"),
    ("tiny_hevc8_bframes.mp4", "NV12"),
    ("tiny_hevc10_bframes.mp4", "I420P10"),
    ("tiny_hevc10_bframes.mp4", "NV12"),
];

#[test]
fn vt_lane_matches_software_over_seeking_ranges() {
    for &(name, fmt) in INTERFRAME {
        let p = fixture(name);
        let sw = run(&p, fmt, software(), RANGES);
        assert_eq!(sw.info.lane, "software");
        let vt = run(&p, fmt, auto(FaultPlan::default()), RANGES);
        assert_eq!(
            vt.info.lane, "videotoolbox",
            "{name}: expected the VT lane, got: {}",
            vt.info.lane_reason
        );
        // 58 deliveries: the ranges leave gaps and re-deliver the backward
        // window, so this pins the script's exact coverage.
        assert_eq!(sw.frames.len(), 58, "{name}: software frame count");
        let stats = compare(&format!("{name}/{fmt}"), &sw, &vt);
        println!("{name}/{fmt}: {stats:?}");
        assert_faithful(&format!("{name}/{fmt}"), &stats);
    }
}

#[test]
fn vt_prores_lane_matches_software_or_declines_cleanly() {
    // ProRes VT needs a ProRes engine (M1 Pro/Max, M2+); a base M1 or a hosted
    // runner declines at the probe and the session opens on software.
    let p = fixture("tiny_prores.mov");
    let ranges = &[(0, 400_000), (400_001, 875_000), (200_000, 500_000)];
    let sw = run(&p, "I420P10", software(), ranges);
    let vt = run(&p, "I420P10", auto(FaultPlan::default()), ranges);
    println!(
        "ProRes export lane: {} ({})",
        vt.info.lane, vt.info.lane_reason
    );
    let stats = compare("prores/I420P10", &sw, &vt);
    assert_faithful("prores/I420P10", &stats);
}

#[test]
fn vt_failure_at_every_frame_resumes_in_software_exactly_once() {
    // Fail the VT lane after k decoded frames for every k across the scripted
    // run (including inside a seek's landing probe, while a past-`b` frame is
    // pending, and in the EOS drain). Every run must deliver the software
    // lane's exact sequence; frames after the downgrade are software-decoded, so
    // they are byte-identical to the reference.
    for &(name, fmt) in &[
        ("tiny_h264_bframes.mp4", "NV12"),
        ("tiny_hevc10_bframes.mp4", "I420P10"),
    ] {
        let p = fixture(name);
        let sw = run(&p, fmt, software(), RANGES);
        // VT frames decoded across RANGES: deliveries plus the pre-`a` reference
        // frames and the landing probes; sweep past the end so the last values
        // exercise "never fails" too.
        for k in (0..110u64).step_by(3) {
            let vt = run(
                &p,
                fmt,
                auto(FaultPlan {
                    fail_after_vt_frames: Some(k),
                    ..Default::default()
                }),
                RANGES,
            );
            assert_eq!(vt.info.lane, "videotoolbox");
            let stats = compare(&format!("{name}/{fmt} fail@{k}"), &sw, &vt);
            assert_faithful(&format!("{name}/{fmt} fail@{k}"), &stats);
        }
    }
}

#[test]
fn vt_seek_failure_resumes_on_software() {
    // Seek 1 is the first range's; seek 2 is the backward re-seek into mid-GOP.
    let p = fixture("tiny_hevc8_bframes.mp4");
    let sw = run(&p, "NV12", software(), RANGES);
    for n in 1..=3 {
        let vt = run(
            &p,
            "NV12",
            auto(FaultPlan {
                fail_vt_seek: Some(n),
                ..Default::default()
            }),
            RANGES,
        );
        let stats = compare(&format!("hevc8 seek-fail#{n}"), &sw, &vt);
        assert_faithful(&format!("hevc8 seek-fail#{n}"), &stats);
    }
}

#[test]
fn vt_probe_failure_opens_on_software_with_a_reason() {
    let p = fixture("tiny_h264_bframes.mp4");
    let sw = run(&p, "NV12", software(), RANGES);
    let vt = run(
        &p,
        "NV12",
        auto(FaultPlan {
            fail_probe: true,
            ..Default::default()
        }),
        RANGES,
    );
    assert_eq!(vt.info.lane, "software");
    assert!(
        vt.info.lane_reason.contains("videotoolbox unavailable"),
        "{}",
        vt.info.lane_reason
    );
    let stats = compare("probe-fail", &sw, &vt);
    for s in stats {
        assert_eq!(s.max_diff, 0, "software fallback must be byte-identical");
    }
}

#[test]
fn ineligible_codec_and_software_policy_stay_on_software() {
    let reg = ExportSwRegistry::new();
    let info = reg
        .open("m", &fixture("tiny_mpeg2.mpg"), "NV12", 6)
        .unwrap();
    assert_eq!(info.lane, "software");
    assert!(
        info.lane_reason.contains("mpeg2video"),
        "{}",
        info.lane_reason
    );
    reg.close("m").unwrap();
    let info = reg
        .open_with_policy(
            "h",
            &fixture("tiny_h264_bframes.mp4"),
            "NV12",
            6,
            ExportLanePolicy::Software,
        )
        .unwrap();
    assert_eq!(info.lane, "software");
    reg.close("h").unwrap();
    assert!(ExportLanePolicy::parse(Some("gpu")).is_err());
}

// ── on-demand: larger conformance media and the CPU bench ────────────────────

fn sidecar() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/ffmpeg/mac/ffmpeg")
}

/// Generate `name` into the shared temp media dir with the GPL sidecar (once;
/// reused across runs). `WEFTCUT_VT_MEDIA` overrides the directory.
fn generate(name: &str, args: &[&str]) -> String {
    let dir = std::env::var_os("WEFTCUT_VT_MEDIA")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("weftcut-vt-conformance"));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join(name);
    if !out.exists() {
        let tmp = dir.join(format!("partial-{name}"));
        let status = std::process::Command::new(sidecar())
            .args(["-v", "error", "-y"])
            .args(args)
            .arg(&tmp)
            .status()
            .expect("run bundled ffmpeg");
        assert!(status.success(), "ffmpeg failed generating {name}");
        std::fs::rename(&tmp, &out).unwrap();
    }
    out.to_string_lossy().into_owned()
}

const BT709: &[&str] = &[
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
];

fn with_tags<'a>(head: &[&'a str]) -> Vec<&'a str> {
    let mut v = head.to_vec();
    v.extend_from_slice(BT709);
    v
}

#[test]
#[ignore]
fn conformance_report() {
    // 1280x720, 4 s at 30 fps, moving + noisy content so every block carries
    // texture; long-GOP sources use B-frames.
    let src = "testsrc2=size=1280x720:rate=30:duration=4,noise=alls=12:allf=t";
    let vui = "colorprim=bt709:transfer=bt709:colormatrix=bt709";
    let x264 = format!("keyint=30:bframes=3:open-gop=1:{vui}");
    let x265 = format!("keyint=30:min-keyint=30:bframes=3:log-level=error:{vui}");
    let media = [
        (
            "H.264 8-bit",
            generate(
                "h264_720p.mp4",
                &with_tags(&[
                    "-f",
                    "lavfi",
                    "-i",
                    src,
                    "-an",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-crf",
                    "20",
                    "-x264-params",
                    &x264,
                ]),
            ),
            &["NV12", "I420P10"][..],
        ),
        (
            "HEVC 8-bit",
            generate(
                "hevc8_720p.mp4",
                &with_tags(&[
                    "-f",
                    "lavfi",
                    "-i",
                    src,
                    "-an",
                    "-c:v",
                    "libx265",
                    "-pix_fmt",
                    "yuv420p",
                    "-crf",
                    "22",
                    "-tag:v",
                    "hvc1",
                    "-x265-params",
                    &x265,
                ]),
            ),
            &["NV12", "I420P10"][..],
        ),
        (
            "HEVC Main10",
            generate(
                "hevc10_720p.mp4",
                &with_tags(&[
                    "-f",
                    "lavfi",
                    "-i",
                    src,
                    "-an",
                    "-c:v",
                    "libx265",
                    "-profile:v",
                    "main10",
                    "-pix_fmt",
                    "yuv420p10le",
                    "-crf",
                    "22",
                    "-tag:v",
                    "hvc1",
                    "-x265-params",
                    &x265,
                ]),
            ),
            &["I420P10", "NV12"][..],
        ),
        (
            "ProRes 422 HQ",
            generate(
                "prores422hq_720p.mov",
                &with_tags(&[
                    "-f",
                    "lavfi",
                    "-i",
                    src,
                    "-an",
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "3",
                    "-pix_fmt",
                    "yuv422p10le",
                ]),
            ),
            &["I420P10", "NV12"][..],
        ),
    ];
    let ranges = &[
        (0, 1_500_000),
        (1_500_001, 2_400_000),
        (1_150_000, 1_600_000),
        (3_000_000, 10_000_000),
    ];
    println!(
        "\n| fixture | out | lane | frames | Y PSNR / max | U PSNR / max | V PSNR / max | colour tags (range/matrix/primaries/transfer) | tags match |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    for (label, path, fmts) in &media {
        for fmt in *fmts {
            let sw = run(path, fmt, software(), ranges);
            let vt = run(path, fmt, auto(FaultPlan::default()), ranges);
            let s = compare(&format!("{label}/{fmt}"), &sw, &vt);
            let cell = |p: &PlaneStat| {
                if p.psnr_db.is_infinite() {
                    format!("∞ / {}", p.max_diff)
                } else {
                    format!("{:.1} dB / {}", p.psnr_db, p.max_diff)
                }
            };
            let c = &vt.frames[0].color;
            let tags = format!(
                "{}/{}/{}/{}",
                c.range.as_deref().unwrap_or("-"),
                c.matrix.as_deref().unwrap_or("-"),
                c.primaries.as_deref().unwrap_or("-"),
                c.transfer.as_deref().unwrap_or("-")
            );
            // "yes": `compare` already asserted per-frame tag equality.
            println!(
                "| {label} | {fmt} | {} | {} | {} | {} | {} | {tags} | yes |",
                vt.info.lane,
                vt.frames.len(),
                cell(&s[0]),
                cell(&s[1]),
                cell(&s[2]),
            );
            assert_faithful(&format!("{label}/{fmt}"), &s);
        }
    }
}

/// Process-wide resource usage (`getrusage(RUSAGE_SELF)`), user + system µs.
fn self_cpu_us() -> (i64, i64) {
    #[repr(C)]
    struct Timeval {
        sec: i64,
        usec: i32,
    }
    #[repr(C)]
    struct Rusage {
        utime: Timeval,
        stime: Timeval,
        rest: [i64; 14],
    }
    extern "C" {
        fn getrusage(who: i32, usage: *mut Rusage) -> i32;
    }
    let mut r: Rusage = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { getrusage(0, &mut r) }, 0);
    (
        r.utime.sec * 1_000_000 + r.utime.usec as i64,
        r.stime.sec * 1_000_000 + r.stime.usec as i64,
    )
}

/// Total CPU seconds of every running VideoToolbox decoder service (VT decodes
/// out of process; its CPU never shows in our rusage).
fn vt_service_cpu_s() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-axo", "time=,comm="])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains("VTDecoderXPCService"))
        .filter_map(|l| l.split_whitespace().next())
        .map(|t| {
            // [[dd-]hh:]mm:ss.ss
            t.split(':').fold(0.0, |acc, part| {
                acc * 60.0 + part.parse::<f64>().unwrap_or(0.0)
            })
        })
        .sum()
}

#[test]
#[ignore]
fn bench_export_decode_cpu() {
    // ~20 s of 4K HEVC at 30 fps, encoded on VideoToolbox at a camera-like
    // bitrate over noisy content (cheap to generate; the decode cost is what's
    // measured, not the encode).
    let src = "testsrc2=size=3840x2160:rate=30:duration=20,noise=alls=10:allf=t";
    let clips = [
        (
            "HEVC 8-bit 4K",
            generate(
                "hevc8_4k_20s.mp4",
                &with_tags(&[
                    "-f",
                    "lavfi",
                    "-i",
                    src,
                    "-an",
                    "-c:v",
                    "hevc_videotoolbox",
                    "-profile:v",
                    "main",
                    "-pix_fmt",
                    "nv12",
                    "-b:v",
                    "60M",
                    "-tag:v",
                    "hvc1",
                ]),
            ),
            "NV12",
        ),
        (
            "HEVC 10-bit 4K",
            generate(
                "hevc10_4k_20s.mp4",
                &with_tags(&[
                    "-f",
                    "lavfi",
                    "-i",
                    src,
                    "-an",
                    "-c:v",
                    "hevc_videotoolbox",
                    "-profile:v",
                    "main10",
                    "-pix_fmt",
                    "p010le",
                    "-b:v",
                    "60M",
                    "-tag:v",
                    "hvc1",
                ]),
            ),
            "I420P10",
        ),
    ];
    // Production's software decode thread budget: main configures it from the
    // processing allocation's `task_threads` = min(4, cores / 2)
    // (`shared/resource-policy.ts`). `WEFTCUT_BENCH_DECODE_THREADS` overrides.
    let threads = std::env::var("WEFTCUT_BENCH_DECODE_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    crate::preview_sw::decoder::configure_decode_threads(threads);
    println!("\nsoftware decode threads: {threads}");
    println!(
        "| clip | out | lane | frames | wall s | fps | user CPU s | sys CPU s | VT service CPU s |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    for (label, path, fmt) in &clips {
        for options in [software(), auto(FaultPlan::default())] {
            let (u0, s0) = self_cpu_us();
            let vt0 = vt_service_cpu_s();
            let t0 = Instant::now();
            let r = run_counting(path, fmt, options);
            let wall = t0.elapsed().as_secs_f64();
            let (u1, s1) = self_cpu_us();
            let vt1 = vt_service_cpu_s();
            println!(
                "| {label} | {fmt} | {} | {} | {wall:.2} | {:.1} | {:.2} | {:.2} | {:.2} |",
                r.0,
                r.1,
                r.1 as f64 / wall,
                (u1 - u0) as f64 / 1e6,
                (s1 - s0) as f64 / 1e6,
                vt1 - vt0
            );
        }
    }
}

/// Bench driver: one range over the whole clip, frames dropped on arrival
/// (only counted), credits returned as fast as they are consumed.
fn run_counting(path: &str, fmt: &str, options: ExportOpenOptions) -> (&'static str, usize) {
    let count = Arc::new(Mutex::new((0usize, false)));
    let c2 = count.clone();
    let reg = ExportSwRegistry::new();
    reg.set_sink(Box::new(move |poke| {
        let mut c = c2.lock().unwrap();
        match poke {
            ExportPoke::Frame { .. } => c.0 += 1,
            ExportPoke::RangeEnd { .. } => c.1 = true,
            ExportPoke::Ended { .. } => {}
            ExportPoke::Error { message, .. } => panic!("bench decode error: {message}"),
        }
    }));
    let info = reg.open_with_options("b", path, fmt, 6, options).unwrap();
    reg.decode_range("b", 0, 1_000_000_000).unwrap();
    let mut returned = 0usize;
    loop {
        let (n, done) = *count.lock().unwrap();
        if n > returned {
            reg.return_credit("b", (n - returned) as u32).unwrap();
            returned = n;
        }
        if done {
            break;
        }
        thread::sleep(Duration::from_micros(200));
    }
    reg.close("b").unwrap();
    let n = count.lock().unwrap().0;
    (info.lane, n)
}
