//! The durable transcript: what `transcribe_clip` heard, kept per source so a
//! later call — or a later session, through `media://{id}/transcript` — reads
//! it back without running speech again.
//!
//! Twin of [`vlm::description`](crate::vlm::description)'s range-lazy cache
//! (ADR 0122), with two differences that are the whole design (ADR 0142):
//!
//! - **The view axes are request arguments, not app settings.** A description
//!   is read under the app's own sampling, focus and language, so its resource
//!   resolves ONE key from injected settings. A transcript's axes — the engine,
//!   its model, the language hint and the word-timing request — are what the
//!   caller passed, and a URI cannot carry them. So entries live in a
//!   per-source directory, `transcripts/<source_hash>/<key>.json`, and the
//!   resource lists every entry of the source rather than guessing which one.
//! - **Membership is by midpoint, not by overlap.** A segment is a sentence:
//!   a window that clips it in half must still answer it whole or not at all,
//!   so a segment belongs to the window holding its midpoint and its times are
//!   clamped to that window on the way out.
//!
//! Stored times are **source-absolute** microseconds (the cache is keyed by
//! source content, so one entry serves every layer on that source); the tool
//! maps them onto the timeline per call ([`place_on_timeline`]).

use serde::{Deserialize, Serialize};

use super::backend::SpeechBackend;
use super::config::BackendConfig;
use super::transcript::{Segment, Word, WordTiming};

/// Bump when a parser or the normalization of raw engine output changes what
/// a transcript holds, so entries written by the older code are re-derived
/// rather than reused. Part of the cache key.
pub const TRANSCRIPT_CACHE_VERSION: u32 = 1;

/// The model a backend runs, as the cache tells two of them apart: the cloud
/// model name, or a local model file's path, size and mtime (and FunASR's
/// tokens, which are part of its model bundle). Swapping the weights behind
/// one path is a different model and a different key. Secrets, devices and
/// thread counts do not identify a model.
pub fn model_identity(backend: SpeechBackend, cfg: Option<&BackendConfig>) -> String {
    match cfg {
        Some(BackendConfig::Local { model, tokens, .. }) => {
            let stem = model
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("local")
                .to_string();
            let identity = std::iter::once(model)
                .chain(tokens.iter())
                .map(|path| {
                    let meta = std::fs::metadata(path).ok();
                    format!(
                        "{}:{:?}:{:?}",
                        path.display(),
                        meta.as_ref().map(|m| m.len()),
                        meta.and_then(|m| m.modified().ok())
                    )
                })
                .collect::<Vec<_>>()
                .join("|");
            format!(
                "{stem}-{}",
                &blake3::hash(identity.as_bytes()).to_hex()[..16]
            )
        }
        _ => match backend {
            SpeechBackend::OpenAi => super::backends::openai::WHISPER_MODEL.to_string(),
            other => other.as_str().to_string(),
        },
    }
}

/// The language hint as a key axis: trimmed and lower-cased, `"auto"` when
/// absent or blank. A hint is in the key because a wrong auto-detect is the
/// very reason a caller retries with one; a shared key would hand the bad
/// transcript back forever.
pub fn language_key(hint: Option<&str>) -> String {
    match hint.map(str::trim).filter(|h| !h.is_empty()) {
        Some(h) => h.to_ascii_lowercase(),
        None => "auto".into(),
    }
}

/// Content-addressed key over source, engine, model, language hint, word-timing
/// request and cache version.
pub fn cache_key(
    source_hash: &str,
    backend: SpeechBackend,
    model: &str,
    language: &str,
    word_timestamps: bool,
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(b"transcript-v\0");
    h.update(&TRANSCRIPT_CACHE_VERSION.to_le_bytes());
    h.update(b"\0");
    h.update(source_hash.as_bytes());
    h.update(b"\0");
    h.update(backend.as_str().as_bytes());
    h.update(b"\0");
    h.update(model.as_bytes());
    h.update(b"\0");
    h.update(language.as_bytes());
    h.update(b"\0");
    h.update(if word_timestamps { b"words" } else { b"cues" });
    h.finalize().to_hex().to_string()
}

/// One stored transcript: the view it answers (`backend`, `model`,
/// `language_hint`, `word_timestamps` — the key's axes, kept readable so the
/// resource can say which entry is which), what the engine reported
/// (`language`, `word_timing`), and the covered source spans with every
/// segment heard in them, source-absolute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptCache {
    pub backend: String,
    pub model: String,
    pub language_hint: String,
    pub word_timestamps: bool,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default = "no_word_timing")]
    pub word_timing: WordTiming,
    /// Merged, sorted, non-overlapping `[start_us, end_us]` source spans.
    #[serde(default)]
    pub covered_ranges: Vec<[i64; 2]>,
    /// Every segment heard so far, source-absolute, sorted by start.
    #[serde(default)]
    pub segments: Vec<Segment>,
}

fn no_word_timing() -> WordTiming {
    WordTiming::None
}

impl Default for TranscriptCache {
    fn default() -> Self {
        Self {
            backend: String::new(),
            model: String::new(),
            language_hint: String::new(),
            word_timestamps: true,
            language: None,
            word_timing: no_word_timing(),
            covered_ranges: Vec::new(),
            segments: Vec::new(),
        }
    }
}

fn midpoint(seg: &Segment) -> i64 {
    seg.t_start_us + (seg.t_end_us - seg.t_start_us) / 2
}

fn holds(in_us: i64, out_us: i64, t: i64) -> bool {
    t >= in_us && t < out_us
}

impl TranscriptCache {
    /// True when `[in_us, out_us]` lies inside one covered range — the "no
    /// engine spawn" fast path.
    pub fn covers(&self, in_us: i64, out_us: i64) -> bool {
        self.covered_ranges
            .iter()
            .any(|[a, b]| *a <= in_us && *b >= out_us)
    }

    /// Fold a freshly heard window in: the prior segments whose midpoint lies
    /// inside `[in_us, out_us)` are replaced by `fresh` (already
    /// source-absolute), and the window joins `covered_ranges`. The engine's
    /// own report (`language`, `word_timing`) is the latest run's.
    pub fn merge_window(
        &mut self,
        in_us: i64,
        out_us: i64,
        fresh: Vec<Segment>,
        language: Option<String>,
        word_timing: WordTiming,
    ) {
        self.segments.retain(|s| !holds(in_us, out_us, midpoint(s)));
        self.segments.extend(fresh);
        self.segments.sort_by_key(|s| (s.t_start_us, s.t_end_us));
        self.covered_ranges.push([in_us, out_us]);
        self.covered_ranges = merge_ranges(std::mem::take(&mut self.covered_ranges));
        if language.is_some() {
            self.language = language;
        }
        self.word_timing = word_timing;
    }

    /// The segments of `[in_us, out_us)`: each one whose midpoint lies inside,
    /// with its own and its words' times clamped to the window, and any word
    /// that clamps to nothing dropped. Source-absolute.
    pub fn segments_in(&self, in_us: i64, out_us: i64) -> Vec<Segment> {
        let clamp = |t: i64| t.clamp(in_us, out_us);
        self.segments
            .iter()
            .filter(|s| holds(in_us, out_us, midpoint(s)))
            .map(|s| Segment {
                t_start_us: clamp(s.t_start_us),
                t_end_us: clamp(s.t_end_us),
                text: s.text.clone(),
                words: s
                    .words
                    .iter()
                    .map(|w| Word {
                        t_start_us: clamp(w.t_start_us),
                        t_end_us: clamp(w.t_end_us),
                        text: w.text.clone(),
                    })
                    .filter(|w| w.t_end_us > w.t_start_us)
                    .collect(),
            })
            .collect()
    }
}

/// Map source-absolute segments onto the timeline for one window: a source
/// instant `s` lands at `timeline_start_us + (s - source_in_us) / rate` — the
/// same rounding the engine's slice-relative output always took — clamped to
/// the window's timeline span so a rounding never steps outside the layer.
pub fn place_on_timeline(
    segments: &mut [Segment],
    source_in_us: i64,
    timeline_start_us: i64,
    timeline_end_us: i64,
    rate: f64,
) {
    let place = |s: i64| {
        let offset = ((s - source_in_us) as f64 / rate).round() as i64;
        timeline_start_us
            .saturating_add(offset)
            .clamp(timeline_start_us, timeline_end_us)
    };
    for seg in segments {
        seg.t_start_us = place(seg.t_start_us);
        seg.t_end_us = place(seg.t_end_us);
        for w in &mut seg.words {
            w.t_start_us = place(w.t_start_us);
            w.t_end_us = place(w.t_end_us);
        }
    }
}

/// Merge `[start, end]` spans into sorted, non-overlapping ranges.
fn merge_ranges(mut ranges: Vec<[i64; 2]>) -> Vec<[i64; 2]> {
    ranges.sort_by_key(|r| r[0]);
    let mut out: Vec<[i64; 2]> = Vec::with_capacity(ranges.len());
    for [a, b] in ranges {
        if let Some(last) = out.last_mut() {
            if a <= last[1] {
                last[1] = last[1].max(b);
                continue;
            }
        }
        out.push([a, b]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: i64, b: i64, text: &str) -> Segment {
        Segment {
            t_start_us: a,
            t_end_us: b,
            text: text.into(),
            words: vec![Word {
                t_start_us: a,
                t_end_us: b,
                text: text.into(),
            }],
        }
    }

    fn cache(segments: Vec<Segment>, covered: Vec<[i64; 2]>) -> TranscriptCache {
        TranscriptCache {
            backend: "whisper_cpp".into(),
            model: "m".into(),
            language_hint: "auto".into(),
            word_timestamps: true,
            language: None,
            word_timing: WordTiming::Exact,
            covered_ranges: covered,
            segments,
        }
    }

    #[test]
    fn key_separates_every_axis() {
        let base = cache_key("h", SpeechBackend::WhisperCpp, "m", "auto", true);
        assert_eq!(
            base,
            cache_key("h", SpeechBackend::WhisperCpp, "m", "auto", true)
        );
        for other in [
            cache_key("h2", SpeechBackend::WhisperCpp, "m", "auto", true),
            cache_key("h", SpeechBackend::FunAsr, "m", "auto", true),
            cache_key("h", SpeechBackend::WhisperCpp, "m2", "auto", true),
            cache_key("h", SpeechBackend::WhisperCpp, "m", "en", true),
            cache_key("h", SpeechBackend::WhisperCpp, "m", "auto", false),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn language_key_normalizes_and_defaults_to_auto() {
        assert_eq!(language_key(None), "auto");
        assert_eq!(language_key(Some("  ")), "auto");
        assert_eq!(language_key(Some(" EN ")), "en");
    }

    #[test]
    fn cloud_model_identity_is_the_model_name() {
        assert_eq!(
            model_identity(
                SpeechBackend::OpenAi,
                Some(&BackendConfig::ApiKey("k".into()))
            ),
            "whisper-1"
        );
    }

    #[test]
    fn local_model_identity_moves_when_the_weights_change() {
        let dir = tempfile::tempdir().unwrap();
        let model = dir.path().join("ggml-base.bin");
        std::fs::write(&model, b"one").unwrap();
        let cfg = BackendConfig::Local {
            binary: dir.path().join("whisper-cli"),
            model: model.clone(),
            tokens: None,
            device: None,
            threads: None,
        };
        let first = model_identity(SpeechBackend::WhisperCpp, Some(&cfg));
        assert!(first.starts_with("ggml-base-"), "{first}");
        std::fs::write(&model, b"other weights").unwrap();
        assert_ne!(first, model_identity(SpeechBackend::WhisperCpp, Some(&cfg)));
    }

    #[test]
    fn covers_only_inside_one_merged_range() {
        let c = cache(vec![], vec![[0, 1_000], [2_000, 3_000]]);
        assert!(c.covers(100, 900));
        assert!(c.covers(2_000, 3_000));
        assert!(!c.covers(500, 2_500));
        assert!(!c.covers(3_000, 3_100));
    }

    #[test]
    fn merge_replaces_by_midpoint_and_folds_ranges() {
        let mut c = cache(
            vec![seg(0, 400, "a"), seg(600, 1_000, "b")],
            vec![[0, 1_000]],
        );
        // A new window over [500, 1500): "b" (mid 800) is replaced, "a" stays.
        c.merge_window(
            500,
            1_500,
            vec![seg(600, 1_400, "B")],
            Some("en".into()),
            WordTiming::Exact,
        );
        let texts: Vec<_> = c.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["a", "B"]);
        assert_eq!(c.covered_ranges, vec![[0, 1_500]]);
        assert_eq!(c.language.as_deref(), Some("en"));
    }

    #[test]
    fn segments_in_takes_whole_segments_by_midpoint_and_clamps_them() {
        let c = cache(
            vec![
                seg(0, 1_000, "edge"),
                seg(1_000, 1_400, "in"),
                seg(1_800, 3_000, "out"),
            ],
            vec![[0, 3_000]],
        );
        // Window [400, 2000): "edge" (mid 500) is in, clamped to 400; "out"
        // (mid 2400) is not, though it overlaps.
        let got = c.segments_in(400, 2_000);
        let texts: Vec<_> = got.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["edge", "in"]);
        assert_eq!(got[0].t_start_us, 400);
        assert_eq!(got[0].words[0].t_start_us, 400);
    }

    #[test]
    fn segments_in_drops_a_word_that_clamps_to_nothing() {
        let mut s = seg(0, 1_000, "a b");
        s.words = vec![
            Word {
                t_start_us: 0,
                t_end_us: 200,
                text: "a".into(),
            },
            Word {
                t_start_us: 300,
                t_end_us: 1_000,
                text: "b".into(),
            },
        ];
        let c = cache(vec![s], vec![[0, 1_000]]);
        let got = c.segments_in(250, 1_000);
        assert_eq!(got[0].words.len(), 1);
        assert_eq!(got[0].words[0].text, "b");
    }

    #[test]
    fn placement_maps_source_onto_the_timeline_through_the_rate() {
        // Source window starts at 10 s, plays at 2x from timeline 4 s.
        let mut segs = vec![seg(10_000_000, 12_000_000, "x")];
        place_on_timeline(&mut segs, 10_000_000, 4_000_000, 6_000_000, 2.0);
        assert_eq!(segs[0].t_start_us, 4_000_000);
        assert_eq!(segs[0].t_end_us, 5_000_000);
        // Never outside the window.
        let mut segs = vec![seg(9_000_000, 30_000_000, "y")];
        place_on_timeline(&mut segs, 10_000_000, 4_000_000, 6_000_000, 2.0);
        assert_eq!(
            (segs[0].t_start_us, segs[0].t_end_us),
            (4_000_000, 6_000_000)
        );
    }

    #[test]
    fn the_stored_value_round_trips() {
        let c = cache(vec![seg(0, 10, "a")], vec![[0, 10]]);
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<TranscriptCache>(&json).unwrap(), c);
    }
}
