//! The normalized transcript shape every speech backend converges on.
//!
//! Backends emit different *styles* (SRT, whisper JSON, FunASR JSON); a
//! per-style [`parse`](super::parse) turns each into this one structure so
//! consumers (the `transcribe_clip` tool, the scene/content-analysis
//! word-transcript resource) see a single shape regardless of engine. The only
//! thing that differs across backends is [`WordTiming`] — the provenance of the
//! per-word timestamps — and it is inspectable.
//!
//! Timestamps are microseconds. As produced by a parser they are
//! **audio-slice-relative** (0 = first sample of the extracted window); the
//! tool layer calls [`Transcript::shift`] to place them on the timeline before
//! returning to the agent. [`Transcript::render_srt`] is the bridge back to the
//! `apply_subtitles` caption flow (SRT is cue-granular, so word spans are not
//! represented there — by design; they live in the JSON `segments`).

use serde::{Deserialize, Serialize};

/// Provenance of the per-word timestamps in a [`Transcript`]. Downstream
/// text-editing reads this to know whether a word boundary is frame-trustworthy
/// (`Exact`, straight from an engine's token offsets) or approximate
/// (`InterpolatedFromCue`, derived by splitting a cue span across its words).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WordTiming {
    /// Word times come straight from the engine's per-token offsets.
    Exact,
    /// Word times were derived by distributing a cue span across its words by
    /// length — approximate, not sample-accurate.
    InterpolatedFromCue,
    /// No word-level timing available (segment granularity only).
    None,
}

/// One word with its own `[t_start_us, t_end_us]` span.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
}

/// One transcript segment — an SRT cue, or a whisper `transcription[]` entry:
/// a timed span of text plus its constituent [`Word`]s.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub text: String,
    pub words: Vec<Word>,
}

/// The single normalized shape produced by every backend after parsing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
    pub language: Option<String>,
    pub word_timing: WordTiming,
}

impl Transcript {
    /// Shift every segment and word timestamp forward by `offset_us` (the
    /// slice's timeline-absolute start), clamping at zero so a negative result
    /// never underflows. Shifts the parsed struct; a caller that needs a cue
    /// body re-renders it via [`render_srt`].
    ///
    /// [`render_srt`]: Transcript::render_srt
    pub fn shift(&mut self, offset_us: i64) {
        for seg in &mut self.segments {
            seg.t_start_us = shift_us(seg.t_start_us, offset_us);
            seg.t_end_us = shift_us(seg.t_end_us, offset_us);
            for w in &mut seg.words {
                w.t_start_us = shift_us(w.t_start_us, offset_us);
                w.t_end_us = shift_us(w.t_end_us, offset_us);
            }
        }
    }

    /// Render the segments back to an SRT body (cue granularity — index /
    /// `HH:MM:SS,mmm --> HH:MM:SS,mmm` / text / blank line). This is what
    /// `transcribe_clip` returns in the envelope's `srt` field so the existing
    /// `apply_subtitles` flow keeps working. Cue indices are renumbered from 1;
    /// per-word times are intentionally not emitted (SRT can't represent them).
    pub fn render_srt(&self) -> String {
        render_srt_segments(&self.segments)
    }

    /// Re-segment the transcript into sentences: one [`Segment`] per sentence,
    /// with the words it holds (spans preserved, so [`WordTiming`] survives).
    ///
    /// A sentence ends where the speaker pausable ends one — an inter-word gap
    /// of at least [`SENTENCE_GAP_US`], or terminal punctuation on the previous
    /// word — and over-long runs are then subdivided at their widest interior
    /// hole exactly as the FunASR parser subdivides over-long cues, so the
    /// output is caption-ready for every backend, not just FunASR. Backends
    /// already segment this way (FunASR's cues) pass through nearly unchanged;
    /// choppy word-fragment segments (SRT-style) merge into readable cues.
    ///
    /// A transcript with no word timing (`WordTiming::None`, empty `words`)
    /// has nothing to merge on and comes back as its engine segments.
    pub fn sentences(&self) -> Vec<Segment> {
        let words: Vec<&Word> = self.segments.iter().flat_map(|s| s.words.iter()).collect();
        if words.is_empty() {
            return self.segments.clone();
        }
        let cjk = is_cjk_transcript(self.language.as_deref(), &words);
        let mut out = Vec::new();
        let mut run: Vec<&Word> = Vec::new();
        for w in words {
            let ends_sentence = run.last().is_some_and(|p: &&Word| {
                w.t_start_us - p.t_end_us >= SENTENCE_GAP_US || ends_with_terminal(p.text.as_str())
            });
            if ends_sentence {
                emit_sentence(&mut out, std::mem::take(&mut run), cjk);
            }
            run.push(w);
        }
        emit_sentence(&mut out, run, cjk);
        out
    }
}

/// Render any segment slice as an SRT body — [`Transcript::render_srt`] over
/// `self.segments`, and the `srt` format of `media://{id}/transcript` over a
/// windowed / sentence-merged view.
pub fn render_srt_segments(segments: &[Segment]) -> String {
    let mut out = String::new();
    for (i, seg) in segments.iter().enumerate() {
        out.push_str(&(i + 1).to_string());
        out.push('\n');
        out.push_str(&format_srt_timestamp(seg.t_start_us));
        out.push_str(" --> ");
        out.push_str(&format_srt_timestamp(seg.t_end_us));
        out.push('\n');
        out.push_str(&seg.text);
        out.push('\n');
        out.push('\n');
    }
    out
}

/// Silence that ends a sentence, in microseconds — the hole between one word's
/// end and the next word's start. The same 0.5 s the FunASR parser thresholds
/// token-onset silence at (`MIN_SILENCE_US` there, silero-vad's own
/// `min_silence_duration` default): one number across the platform, so an
/// agent never re-derives it per backend.
pub const SENTENCE_GAP_US: i64 = 500_000;

/// Readability caps for one sentence: the span and the character count past
/// which a run is subdivided even though no sentence boundary fired — the same
/// 6 s subtitle convention and the same CJK line measure the FunASR parser
/// enforces on its cues (`MAX_CUE_US` / `MAX_CUE_CHARS` there), so sentence
/// output reads as captions whatever the engine. Latin scripts read ~3.5x
/// fewer characters per line, so their cap is two full subtitle lines (84)
/// rather than the CJK line-and-a-half (24); without the split a Latin cap
/// would shred every sentence back into the choppy cues this exists to fix.
pub const MAX_SENTENCE_US: i64 = 6_000_000;
pub const MAX_SENTENCE_CHARS_CJK: usize = 24;
pub const MAX_SENTENCE_CHARS_LATIN: usize = 84;

/// Characters that terminate a sentence when they close a word — ASCII plus
/// the CJK full-stop / exclamation / question marks and the ellipsis, which is
/// sentence-terminal in both traditions. Commas and enumeration marks never
/// end a sentence.
fn ends_with_terminal(text: &str) -> bool {
    text.trim_end()
        .chars()
        .last()
        .is_some_and(|c| matches!(c, '.' | '?' | '!' | '。' | '！' | '？' | '…'))
}

/// Whether CJK joining and CJK readability caps apply: the transcript language
/// says so (`zh`, `ja`, `yue`, …), or — with no language to speak for — the
/// words themselves are CJK-dominant. Hangul counts as Latin here (Korean
/// delimits words with spaces), matching `parse::is_cjk_char`'s exclusion.
fn is_cjk_transcript(language: Option<&str>, words: &[&Word]) -> bool {
    if let Some(tag) = language {
        let base = tag.split(['-', '_']).next().unwrap_or("").to_lowercase();
        return matches!(
            base.as_str(),
            "zh" | "yue" | "ja" | "jp" | "lzh" | "wuu" | "hsn"
        );
    }
    let (mut cjk, mut total) = (0usize, 0usize);
    for w in words {
        for c in w.text.chars() {
            if c.is_whitespace() {
                continue;
            }
            total += 1;
            if super::parse::is_cjk_char(c) {
                cjk += 1;
            }
        }
    }
    total > 0 && cjk * 2 >= total
}

/// Push one run as a sentence, subdividing it first when it is too long to
/// read. The cut goes at the run's WIDEST interior hole — the longest breath
/// left — never at the cap itself, ties toward the middle; recurses, so a
/// long monologue comes apart at its N largest pauses. Mirrors the FunASR
/// parser's `emit_cue` (the same guarantee its cues carry).
fn emit_sentence(out: &mut Vec<Segment>, run: Vec<&Word>, cjk: bool) {
    if run.is_empty() {
        return;
    }
    let t_start_us = run[0].t_start_us;
    let t_end_us = run[run.len() - 1].t_end_us;
    let max_chars = if cjk {
        MAX_SENTENCE_CHARS_CJK
    } else {
        MAX_SENTENCE_CHARS_LATIN
    };
    let text = super::parse::funasr_json::join_words(
        &run.iter().map(|w| (*w).clone()).collect::<Vec<Word>>(),
    );
    if run.len() > 1
        && (t_end_us - t_start_us > MAX_SENTENCE_US || text.chars().count() > max_chars)
    {
        let mid = (run.len() / 2) as i64;
        let at = (1..run.len())
            .max_by_key(|&i| {
                (
                    run[i].t_start_us - run[i - 1].t_end_us,
                    -(i as i64 - mid).abs(),
                )
            })
            .expect("run.len() > 1 leaves at least one interior boundary");
        let mut head = run;
        let tail = head.split_off(at);
        emit_sentence(out, head, cjk);
        emit_sentence(out, tail, cjk);
        return;
    }
    out.push(Segment {
        t_start_us,
        t_end_us,
        text,
        words: run.into_iter().cloned().collect(),
    });
}

/// Bump when the transcript normalization or the sentence contract changes so
/// stale cached transcripts (computed under older rules) are re-derived rather
/// than reused. Part of the transcript cache key.
pub const TRANSCRIPT_CACHE_VERSION: u32 = 1;

/// The content-addressed transcript cache key: `blake3(source_hash |
/// backend | model | language-hint | word-timestamps-flag |
/// TRANSCRIPT_CACHE_VERSION)`, hex. A change to any input (different engine,
/// a swapped local model file, a different language hint, exact vs
/// interpolated word timing) yields a fresh key, so a stale transcript is
/// never reused. The source content hash auto-invalidates a relink-by-content.
///
/// ONE conversion, called by `transcribe_clip` (the writer) and by
/// `media://{id}/transcript` (the reader) alike — two spellings would be two
/// keys for one transcript, diverging silently.
pub fn transcript_cache_key(
    source_hash: &str,
    backend_tag: &str,
    model_identity: &str,
    language_hint: Option<&str>,
    want_word_timing: bool,
) -> String {
    let mut h = blake3::Hasher::new();
    h.update(source_hash.as_bytes());
    h.update(b"\0");
    h.update(backend_tag.as_bytes());
    h.update(b"\0");
    h.update(model_identity.as_bytes());
    h.update(b"\0");
    h.update(language_hint.unwrap_or("auto").as_bytes());
    h.update(b"\0");
    h.update(&[u8::from(want_word_timing)]);
    h.update(b"\0");
    h.update(&TRANSCRIPT_CACHE_VERSION.to_le_bytes());
    h.finalize().to_hex().to_string()
}

/// The range-lazy incremental cache value: which source ranges have been
/// transcribed, and every engine segment transcribed so far
/// (source-absolute). Mirrors `vlm::DescriptionCache`: a `transcribe_clip`
/// for a window whose `[in, out]` is already inside `covered_ranges` reuses
/// the stored segments with no engine spawn; an uncovered window is computed,
/// merged in, and re-stored. Sentence views are always DERIVED at read time
/// (`sentences()`), never stored, so the engine segmentation stays the one
/// truth both views read from.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TranscriptCache {
    /// Merged, sorted, non-overlapping `[start_us, end_us]` source spans that
    /// have been transcribed.
    #[serde(default)]
    pub covered_ranges: Vec<[i64; 2]>,
    /// All transcribed engine segments, source-absolute, sorted by `t_start_us`.
    #[serde(default)]
    pub segments: Vec<Segment>,
    /// Detected language of the stored transcript, if the engine reported one.
    #[serde(default)]
    pub language: Option<String>,
    /// Provenance of the stored per-word times. Uniform per key because the
    /// key carries the word-timestamps flag — mixed provenance never shares
    /// an entry.
    #[serde(default)]
    pub word_timing: Option<WordTiming>,
}

impl TranscriptCache {
    /// True when `[in_us, out_us]` lies entirely inside the covered union —
    /// the "no re-spawn" fast path.
    pub fn covers(&self, in_us: i64, out_us: i64) -> bool {
        self.covered_ranges
            .iter()
            .any(|[a, b]| *a <= in_us && *b >= out_us)
    }

    /// Segments whose span intersects `[in_us, out_us]`, sorted by start.
    pub fn segments_in(&self, in_us: i64, out_us: i64) -> Vec<Segment> {
        let mut out: Vec<Segment> = self
            .segments
            .iter()
            .filter(|s| s.t_start_us < out_us && s.t_end_us > in_us)
            .cloned()
            .collect();
        out.sort_by_key(|s| s.t_start_us);
        out
    }

    /// Merge freshly-transcribed source-absolute engine segments into the
    /// cache: drop any prior segments intersecting `[in_us, out_us]` (they are
    /// replaced by `fresh`), add the fresh segments, and fold `[in_us, out_us]`
    /// into `covered_ranges`.
    pub fn merge_window(
        &mut self,
        in_us: i64,
        out_us: i64,
        fresh: Vec<Segment>,
        language: Option<String>,
        word_timing: WordTiming,
    ) {
        self.segments
            .retain(|s| !(s.t_start_us < out_us && s.t_end_us > in_us));
        self.segments.extend(fresh);
        self.segments.sort_by_key(|s| s.t_start_us);
        self.covered_ranges.push([in_us, out_us]);
        self.covered_ranges = merge_ranges(std::mem::take(&mut self.covered_ranges));
        self.language = language;
        self.word_timing = Some(word_timing);
    }
}

/// Merge a list of `[start, end]` spans into sorted, non-overlapping ranges
/// (touching/overlapping spans fold together). Twin of the same helper in
/// `vlm::description` — kept local so neither cache depends on the other.
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

fn shift_us(base_us: i64, offset_us: i64) -> i64 {
    base_us.saturating_add(offset_us).max(0)
}

/// `HH:MM:SS,mmm` — the SRT cue-timestamp format.
fn format_srt_timestamp(us: i64) -> String {
    let us = us.max(0);
    let total_ms = us / 1000;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    let s = total_s % 60;
    let total_m = total_s / 60;
    let m = total_m % 60;
    let h = total_m / 60;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(a: i64, b: i64, t: &str) -> Word {
        Word {
            t_start_us: a,
            t_end_us: b,
            text: t.to_string(),
        }
    }

    fn sample() -> Transcript {
        Transcript {
            segments: vec![
                Segment {
                    t_start_us: 1_000_000,
                    t_end_us: 2_500_000,
                    text: "Hello world".into(),
                    words: vec![
                        word(1_000_000, 1_750_000, "Hello"),
                        word(1_750_000, 2_500_000, "world"),
                    ],
                },
                Segment {
                    t_start_us: 3_000_000,
                    t_end_us: 4_000_000,
                    text: "Bye".into(),
                    words: vec![word(3_000_000, 4_000_000, "Bye")],
                },
            ],
            language: Some("en".into()),
            word_timing: WordTiming::InterpolatedFromCue,
        }
    }

    #[test]
    fn shift_moves_segments_and_words_together() {
        let mut t = sample();
        t.shift(500_000);
        assert_eq!(t.segments[0].t_start_us, 1_500_000);
        assert_eq!(t.segments[0].t_end_us, 3_000_000);
        assert_eq!(t.segments[0].words[0].t_start_us, 1_500_000);
        assert_eq!(t.segments[0].words[1].t_end_us, 3_000_000);
        assert_eq!(t.segments[1].words[0].t_start_us, 3_500_000);
    }

    #[test]
    fn shift_clamps_at_zero() {
        let mut t = sample();
        t.shift(-5_000_000);
        for seg in &t.segments {
            assert!(seg.t_start_us >= 0 && seg.t_end_us >= 0);
            for w in &seg.words {
                assert!(w.t_start_us >= 0 && w.t_end_us >= 0);
            }
        }
    }

    #[test]
    fn render_srt_emits_renumbered_cues() {
        let t = sample();
        let srt = t.render_srt();
        assert!(srt.starts_with("1\n00:00:01,000 --> 00:00:02,500\nHello world\n\n"));
        assert!(srt.contains("2\n00:00:03,000 --> 00:00:04,000\nBye\n\n"));
    }

    #[test]
    fn word_timing_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&WordTiming::InterpolatedFromCue).unwrap(),
            "\"interpolated_from_cue\"",
        );
        assert_eq!(
            serde_json::to_string(&WordTiming::Exact).unwrap(),
            "\"exact\""
        );
        assert_eq!(
            serde_json::to_string(&WordTiming::None).unwrap(),
            "\"none\""
        );
    }

    fn sent(words: Vec<Word>, language: Option<&str>) -> Transcript {
        Transcript {
            segments: vec![Segment {
                t_start_us: words[0].t_start_us,
                t_end_us: words[words.len() - 1].t_end_us,
                text: String::new(),
                words,
            }],
            language: language.map(str::to_string),
            word_timing: WordTiming::Exact,
        }
    }

    #[test]
    fn sentences_merge_fragments_across_short_gaps() {
        // Three choppy engine cues' worth of words, 100 ms apart: one sentence.
        let t = sent(
            vec![
                word(0, 200_000, "the"),
                word(300_000, 500_000, "quick"),
                word(600_000, 900_000, "fox"),
            ],
            Some("en"),
        );
        let s = t.sentences();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].text, "the quick fox");
        assert_eq!(s[0].t_start_us, 0);
        assert_eq!(s[0].t_end_us, 900_000);
        // Word spans survive the merge byte-for-byte.
        assert_eq!(
            s[0].words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            ["the", "quick", "fox"]
        );
    }

    #[test]
    fn sentences_break_on_a_long_pause() {
        let t = sent(
            vec![word(0, 200_000, "hello"), word(800_000, 1_000_000, "again")],
            Some("en"),
        );
        let s = t.sentences();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "hello");
        assert_eq!(s[1].text, "again");
    }

    #[test]
    fn sentences_break_on_terminal_punctuation_without_a_pause() {
        let t = sent(
            vec![
                word(0, 200_000, "Hello"),
                word(200_000, 400_000, "world."),
                word(400_000, 600_000, "Bye"),
            ],
            Some("en"),
        );
        let s = t.sentences();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "Hello world.");
        assert_eq!(s[1].text, "Bye");
        // A comma is not terminal.
        let t = sent(
            vec![word(0, 200_000, "Hello,"), word(200_000, 400_000, "world")],
            Some("en"),
        );
        assert_eq!(t.sentences().len(), 1);
    }

    #[test]
    fn sentences_join_cjk_without_spaces_and_break_on_cjk_stops() {
        let t = sent(
            vec![
                word(0, 150_000, "你"),
                word(150_000, 300_000, "好"),
                word(300_000, 450_000, "。"),
                word(450_000, 600_000, "世"),
                word(600_000, 750_000, "界"),
            ],
            Some("zh"),
        );
        let s = t.sentences();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].text, "你好。");
        assert_eq!(s[1].text, "世界");
    }

    #[test]
    fn sentences_subdivide_an_unpunctuated_monologue_at_its_widest_hole() {
        // 30 even Latin words, 100 ms apart, no punctuation: over the 84-char
        // Latin cap, so the run splits at its widest interior hole — here
        // every hole ties, so toward the middle — and recurses.
        let words: Vec<Word> = (0..30)
            .map(|i| word(i * 300_000, i * 300_000 + 200_000, "word"))
            .collect();
        let t = sent(words, Some("en"));
        let s = t.sentences();
        assert!(s.len() > 1, "a 9 s run must subdivide, got {s:?}");
        for seg in &s {
            assert!(seg.text.chars().count() <= MAX_SENTENCE_CHARS_LATIN);
        }
        // Every word survives exactly once, in order.
        assert_eq!(s.iter().flat_map(|x| x.words.iter()).count(), 30,);
    }

    #[test]
    fn sentences_without_word_timing_pass_engine_segments_through() {
        let t = Transcript {
            segments: vec![Segment {
                t_start_us: 0,
                t_end_us: 1_000_000,
                text: "whole cue".into(),
                words: vec![],
            }],
            language: None,
            word_timing: WordTiming::None,
        };
        let s = t.sentences();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].text, "whole cue");
    }

    #[test]
    fn transcript_cache_key_separates_inputs() {
        let a = transcript_cache_key("hash", "openai", "whisper-1", None, true);
        assert_eq!(
            a,
            transcript_cache_key("hash", "openai", "whisper-1", None, true)
        );
        for other in [
            transcript_cache_key("other", "openai", "whisper-1", None, true),
            transcript_cache_key("hash", "whisper_cpp", "whisper-1", None, true),
            transcript_cache_key("hash", "openai", "other-model", None, true),
            transcript_cache_key("hash", "openai", "whisper-1", Some("en"), true),
            transcript_cache_key("hash", "openai", "whisper-1", None, false),
        ] {
            assert_ne!(a, other);
        }
    }

    #[test]
    fn transcript_cache_covers_and_merges_windows() {
        let mut c = TranscriptCache::default();
        assert!(!c.covers(0, 1_000_000));
        c.merge_window(
            0,
            2_000_000,
            vec![Segment {
                t_start_us: 0,
                t_end_us: 1_000_000,
                text: "a".into(),
                words: vec![word(0, 1_000_000, "a")],
            }],
            Some("en".into()),
            WordTiming::Exact,
        );
        assert!(c.covers(0, 2_000_000));
        assert!(!c.covers(0, 3_000_000));
        // A re-transcribed overlapping window replaces the intersected parts.
        c.merge_window(
            1_000_000,
            3_000_000,
            vec![Segment {
                t_start_us: 1_000_000,
                t_end_us: 2_000_000,
                text: "b".into(),
                words: vec![word(1_000_000, 2_000_000, "b")],
            }],
            Some("en".into()),
            WordTiming::Exact,
        );
        assert_eq!(
            c.segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(c.covers(0, 3_000_000));
        assert_eq!(c.segments_in(0, 500_000).len(), 1);
        assert_eq!(c.segments_in(0, 1_500_000).len(), 2);
    }
}
