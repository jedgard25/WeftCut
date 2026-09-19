//! MCP resource readers, transport-free. `read_resource(b, uri, state_json)`
//! dispatches `project://compiled`, `composition://meter` and `media://*`,
//! returning the wire `ResourceResult`; the `project://*` state views are
//! served by the TS MCP host, not here.
//!
//! JSON resources are pretty-printed into a `ResourceContent::Text`; binary
//! ones base64-encode the bytes into a `ResourceContent::Blob`.

use serde_json::Value;
use uuid::Uuid;

use crate::napi_backend::Backend;

#[cfg(feature = "jobs")]
use crate::cache::cached_ok;
#[cfg(feature = "jobs")]
use crate::jobs;
#[cfg(feature = "jobs")]
use crate::state::{MediaId, MediaItem};

use super::wire::{McpToolError, ResourceContent, ResourceDef, ResourceResult};

const URI_PROJECT: &str = "project://current";
const URI_COMPOSITION: &str = "project://composition";
const URI_MEDIA: &str = "project://media";
const URI_TRACKS: &str = "project://tracks";
const URI_TIMELINE: &str = "project://timeline";
const URI_MARKERS: &str = "project://markers";
const URI_COMPOSITIONS: &str = "project://compositions";
const URI_HISTORY: &str = "project://history";
const URI_COMPILED: &str = "project://compiled";
const URI_METER: &str = "composition://meter";
const PREFIX_MEDIA: &str = "media://";

const APP_JSON: &str = "application/json";
#[cfg(feature = "jobs")]
const APP_OCTET: &str = "application/octet-stream";
#[cfg(feature = "jobs")]
const IMAGE_JPEG: &str = "image/jpeg";

/// The state slice the TS MCP host injects for the resources that stay Rust
/// compute: `project://compiled` needs the full project (audio mix
/// plan); `media://*` needs the `MediaItem` resolved by id. `composition://meter`
/// reads live Rust state and needs neither. Both fields `serde(default)` so a
/// stateless read (`{}`) parses cleanly.
#[derive(Default, serde::Deserialize)]
struct ResourceState {
    #[serde(default)]
    project: Option<crate::state::Project>,
    #[serde(default)]
    media: Option<crate::state::MediaItem>,
    /// Injected by the TS host for `media://{id}/description`: the merged
    /// video-understanding backend config (so the cached-view read can resolve
    /// the default backend + compute the cache key). Stateless — same pattern as
    /// `describe_clip`'s injected config (ADR 0024). Empty → "no backend".
    #[cfg(feature = "speech")]
    #[serde(default)]
    vlm_config: std::collections::HashMap<String, crate::vlm::BackendConfig>,
    /// Injected by the TS host for `media://{id}/description`: the app's UI
    /// language, because language is part of the description cache key. It has to
    /// ride in the same way the config does — a resource is addressed by URI and
    /// has no argument to carry it.
    ///
    /// Absent → `Language::DEFAULT_TAG`, which is what a host-less read (an agent
    /// against a bare core) gets. That is also the only shape under which this
    /// resource and `describe_clip` could disagree about which key to look under,
    /// and it is why the host injects on BOTH paths from one value
    /// (`main/index.ts` `uiLanguage`).
    #[cfg(feature = "speech")]
    #[serde(default)]
    language: Option<String>,
    /// Injected by the TS host for `media://{id}/description` for `language`'s
    /// reason, and from the same provider: the app's Video-understanding
    /// sampling rate and prompt focus are cache-key inputs too, and a resource
    /// addressed by URI has no argument to carry them.
    ///
    /// Spelled `describe_*` rather than bare `fps` / `focus` because this state
    /// slice serves EVERY resource, and a bare `fps` beside `project` would read
    /// as the composition's frame rate.
    ///
    /// Absent → [`vlm::DEFAULT_FPS`] / [`vlm::Focus::General`], which is what a
    /// host-less read gets, exactly as an absent `language` yields
    /// `Language::DEFAULT_TAG`.
    #[cfg(feature = "speech")]
    #[serde(default)]
    describe_fps: Option<f64>,
    #[cfg(feature = "speech")]
    #[serde(default)]
    describe_focus: Option<String>,
    /// Injected by the TS host for `media://{id}/description`: the user's SOFT
    /// preferred engine, the fourth cache-key axis. The chosen backend and its
    /// model label are both hashed into the key, so a read that walked the plain
    /// availability order while `describe_clip` honored a preference would look
    /// under a different entry entirely and report every source as undescribed.
    ///
    /// Absent (and `"auto"`, which no backend answers to) → no preference, which
    /// is what a host-less read gets.
    #[cfg(feature = "speech")]
    #[serde(default)]
    describe_preferred: Option<String>,
    /// Injected by the TS host for `media://{id}/transcript`: the user's SOFT
    /// preferred transcription engine, from the same provider `transcribe_clip`'s
    /// `preferred_backend` comes from. The transcript key carries the backend
    /// that served the request, so a read that ignored the preference would
    /// look under another engine's entry and report a transcribed source as
    /// untranscribed. Absent / `"auto"` → no preference: the reader serves the
    /// preferred engine's entry when covered, else the first covered entry in
    /// backend order. A read spawns no engine either way.
    #[cfg(feature = "speech")]
    #[serde(default)]
    transcribe_preferred: Option<String>,
}

/// The four cache-key inputs the app's UI owns, as one argument.
///
/// Grouped rather than passed as four: they are one thing — the VIEW a read
/// resolves — and four positional `Option`s at a call site are one
/// transposition away from a silently wrong key.
#[cfg(feature = "speech")]
struct InjectedView<'a> {
    language: Option<&'a str>,
    fps: Option<f64>,
    focus: Option<&'a str>,
    preferred: Option<&'a str>,
}

fn serialize_err(e: serde_json::Error) -> McpToolError {
    McpToolError::internal_error(format!("serialize: {e}"), None)
}

/// Wrap a pretty-printed JSON body in a `ResourceResult` text content block.
fn text_resource(uri: &str, body: &Value) -> Result<ResourceResult, McpToolError> {
    let text = serde_json::to_string_pretty(body).map_err(serialize_err)?;
    Ok(ResourceResult {
        contents: vec![ResourceContent::Text {
            uri: uri.to_string(),
            mime_type: Some(APP_JSON.to_string()),
            text,
        }],
    })
}

pub(crate) async fn read_resource(
    b: &Backend,
    uri: &str,
    state_json: &str,
) -> Result<ResourceResult, McpToolError> {
    let state: ResourceState = serde_json::from_str(state_json).map_err(|e| {
        McpToolError::internal_error(format!("resource state injection: {e}"), None)
    })?;

    // media://* needs the MediaItem the TS host resolved by id (TS owns state).
    // Peeled off ahead of the URI match: thumbnail / frame / waveform return
    // blobs, /description, /analysis and /transcript return JSON or text.
    if let Some(tail) = uri.strip_prefix(PREFIX_MEDIA) {
        // /transcript — durable-transcript view, needs the injected preference;
        // see `read_transcript_resource`. Matched on the `/transcript` path
        // (before or with a query string) so `?format=` etc. stay on the URI.
        #[cfg(feature = "speech")]
        if tail
            .split('?')
            .next()
            .is_some_and(|p| p.ends_with("/transcript"))
        {
            return read_transcript_resource(
                b,
                uri,
                tail,
                state.media,
                state.transcribe_preferred.as_deref(),
            )
            .await;
        }
        // /description — cached VLM view, needs the injected config; see
        // `read_description_resource`.
        #[cfg(feature = "speech")]
        if let Some(id_part) = tail.strip_suffix("/description") {
            let view = InjectedView {
                language: state.language.as_deref(),
                fps: state.describe_fps,
                focus: state.describe_focus.as_deref(),
                preferred: state.describe_preferred.as_deref(),
            };
            return read_description_resource(
                b,
                uri,
                id_part,
                state.media,
                &state.vlm_config,
                view,
            )
            .await;
        }
        // /analysis — always computable, computes on miss; see
        // `read_analysis_resource`.
        #[cfg(feature = "jobs")]
        if let Some(id_part) = tail.strip_suffix("/analysis") {
            return read_analysis_resource(b, uri, id_part, state.media).await;
        }
        return read_media_resource(b, uri, tail, state.media).await;
    }

    let body: Value = match uri {
        URI_METER => meter_payload(b),
        URI_COMPILED => {
            // The audio mix plan IS the compiled view of the export audio pipeline
            // (ADR 0019). Envelope point COUNTS, not values — keyframed gain on a
            // long layer would be hundreds of thousands of floats. A transient
            // ConformMissing state reports inline instead of failing the read. The
            // TS host injects the full project — this resource is agent-triggered
            // and infrequent.
            //
            // Baked audio effects are INVISIBLE here: the plan is built with no
            // per-layer override table, so a layer whose export audio will come
            // from a baked `.fx-*` conform sibling still reports the raw
            // `media.conform_path` (ADR 0063). The override table lives in the
            // main-process audio-fx baker and is injected only on
            // `export_project_audio_only`; this resource reports the
            // un-overridden plan.
            let project = state.project.ok_or_else(|| {
                McpToolError::internal_error(
                    "project://compiled requires the injected project (TS host)".to_string(),
                    None,
                )
            })?;
            match crate::audio::mix::plan_for_project(&project, None, None) {
                Ok(plan) => serde_json::json!({
                    "kind": "audio_mix_plan",
                    "sample_rate": crate::audio::mix::MIX_SAMPLE_RATE,
                    "window_frames": [plan.window_start_frame, plan.window_end_frame],
                    "layers": plan.layers.iter().map(|l| serde_json::json!({
                        "label": l.label,
                        "conform_path": l.conform_path.display().to_string(),
                        "start_frame": l.start_frame,
                        "src_in_frame": l.src_in_frame,
                        "src_out_frame": l.src_out_frame,
                        "gain_constant": l.gain.is_constant(),
                        "gain_points": l.gain.values.len(),
                        "pan_constant": l.pan.is_constant(),
                        "pan_points": l.pan.values.len(),
                    })).collect::<Vec<_>>(),
                }),
                Err(e) => serde_json::json!({
                    "kind": "audio_mix_plan",
                    "error": e.to_string(),
                }),
            }
        }
        // project://current / composition /
        // media / tracks / markers / history / layers/{id} are served directly by
        // the TS MCP host (the sole state owner) and never reach this reader.
        other => {
            return Err(McpToolError::resource_not_found(
                format!(
                    "unknown or TS-served resource URI: {other} (project://* state views are served by the TS MCP host)",
                ),
                None,
            ));
        }
    };

    text_resource(uri, &body)
}

/// The latest preview master-bus meter reading. Gated on `jobs` (the audio
/// meter slot only exists when the jobs feature is on); reports `live: false`
/// when the feature is off so the resource never 404s.
#[cfg(feature = "jobs")]
fn meter_payload(b: &Backend) -> Value {
    let latest = b.audio_meter.0.lock().expect("meter lock poisoned").clone();
    match latest {
        Some((at, report)) if at.elapsed() < std::time::Duration::from_secs(2) => {
            serde_json::json!({
                "live": true,
                "rms_db": report.rms_db,
                "peak_db": report.peak_db,
            })
        }
        _ => serde_json::json!({ "live": false }),
    }
}

#[cfg(not(feature = "jobs"))]
fn meter_payload(_b: &Backend) -> Value {
    serde_json::json!({ "live": false })
}

// ============================================================
// media://* binary resources
// ============================================================

#[cfg(feature = "jobs")]
async fn read_media_resource(
    b: &Backend,
    uri: &str,
    tail: &str,
    media: Option<MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    // tail = "{id}/thumbnail" | "{id}/frame/{t_us}" | "{id}/waveform"
    let (id_part, sub) = tail.split_once('/').ok_or_else(|| {
        McpToolError::resource_not_found(format!("media URI missing sub-path: {uri}"), None)
    })?;
    let media_id: MediaId = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    // `None` → the id was absent from the project state.
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;

    if sub == "thumbnail" {
        serve_thumbnail(b, uri, &media).await
    } else if sub == "waveform" {
        serve_waveform(b, uri, &media).await
    } else if let Some(t_str) = sub.strip_prefix("frame/") {
        let t_us: i64 = t_str.parse().map_err(|_| {
            McpToolError::invalid_params(format!("frame URI t_us not an integer: {t_str}"), None)
        })?;
        serve_frame(b, uri, &media, t_us).await
    } else {
        Err(McpToolError::resource_not_found(
            format!("unknown media sub-resource '{sub}'"),
            None,
        ))
    }
}

#[cfg(not(feature = "jobs"))]
async fn read_media_resource(
    _b: &Backend,
    uri: &str,
    _tail: &str,
    _media: Option<crate::state::MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    Err(McpToolError::resource_not_found(
        format!("media resources require the jobs feature: {uri}"),
        None,
    ))
}

/// Serve `media://{id}/transcript` — the durable-transcript view
/// `transcribe_clip` writes through: the cached engine segments for one source
/// under one transcript key, windowed / re-segmented / formatted at read time.
///
/// Query (all optional): `format=segments|text|srt` (default `segments`),
/// `segment=sentence|engine` (default `sentence` — the caption-ready view;
/// engine segments are the stored truth both derive from), `detail=full|compact`
/// (default `full`; `compact` drops the per-word arrays for context-cheap
/// reads), `t_start_us` + `t_end_us` (a source-absolute window, overlap;
/// default the whole coverage), `backend` (a strict engine tag — serve that
/// engine's entry or 404), `language` (the hint the transcription ran under;
/// default `auto`, the hint-less key), `words=true|false` (default `true` —
/// exact vs interpolated provenance is a key axis, so match the flag the
/// transcription ran with).
///
/// Source-absolute throughout: a media resource names no layer, and layers
/// move — map to the timeline with the layer's current
/// `t_start_us + (source_us - src_in_us)`. Unlike `media://{id}/analysis`
/// (always computable) this never transcribes on a miss — transcription costs
/// an engine spawn or an API call — and 404s naming the backend checked and
/// the `transcribe_clip` call that fills it. A read spawns no engine either
/// way, so without an explicit `backend` the reader serves the preferred
/// engine's entry when it covers the window, else the first covered entry in
/// backend order: whatever engine transcribed is what the next session finds.
#[cfg(feature = "speech")]
async fn read_transcript_resource(
    b: &Backend,
    uri: &str,
    tail: &str,
    media: Option<crate::state::MediaItem>,
    preferred_hint: Option<&str>,
) -> Result<ResourceResult, McpToolError> {
    use crate::speech;

    // tail = "{id}/transcript[?query]".
    let (id_part, query) = match tail.split_once('?') {
        Some((p, q)) => (p, q),
        None => (tail, ""),
    };
    let id_part = id_part.strip_suffix("/transcript").ok_or_else(|| {
        McpToolError::resource_not_found(format!("unknown media sub-resource in: {uri}"), None)
    })?;
    let media_id = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;
    if media.metadata.audio.is_none() {
        return Err(McpToolError::invalid_request(
            format!("media {media_id} has no audio stream — media://{{id}}/transcript needs an audio source"),
            None,
        ));
    }

    let q = parse_transcript_query(query)?;
    let preferred = preferred_hint.and_then(|tag| {
        speech::SpeechBackend::all()
            .iter()
            .copied()
            .find(|b| b.as_str() == tag)
    });
    // Explicit `backend` is strict (the tool's contract); otherwise the
    // preferred engine first, then backend order — first entry COVERING the
    // window wins.
    let mut ordered: Vec<speech::SpeechBackend> = Vec::new();
    if let Some(x) = q.backend {
        ordered.push(x);
    } else {
        if let Some(p) = preferred {
            ordered.push(p);
        }
        for b in speech::SpeechBackend::all() {
            if !ordered.contains(b) {
                ordered.push(*b);
            }
        }
    }

    // Keys up front, under one short lock scope: nothing below awaits while a
    // guard is held (clippy `await_holding_lock` is lexical, so the scope —
    // not an explicit `drop` — ends the borrow).
    let keys: Vec<(speech::SpeechBackend, String)> = {
        let cfg = b.speech_config.lock().expect("speech_config poisoned");
        ordered
            .into_iter()
            .map(|backend| {
                let key = speech::transcript_cache_key(
                    &media.file_hash_blake3,
                    backend.as_str(),
                    &speech::model_identity(backend, cfg.get(backend.as_str())),
                    q.language.as_deref(),
                    q.want_words,
                );
                (backend, key)
            })
            .collect()
    };
    let mut cached_backends: Vec<String> = Vec::new();
    for (backend, key) in keys {
        let path = b.cache.transcript(&key);
        crate::cache::touch_if_stale(&path);
        if !crate::cache::cached_ok(&path) {
            continue;
        }
        cached_backends.push(backend.as_str().to_string());
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            McpToolError::internal_error(format!("read {}: {e}", path.display()), None)
        })?;
        let cache: speech::TranscriptCache = match serde_json::from_slice(&bytes) {
            Ok(c) => c,
            Err(_) => continue, // a corrupt entry is a miss; the next transcribe overwrites it
        };
        // Sentence-merge BEFORE windowing: a sentence straddling the window
        // edge belongs to both sides, and windowing first would cut it.
        let view = if q.sentence {
            speech::Transcript {
                segments: cache.segments.clone(),
                language: cache.language.clone(),
                word_timing: cache.word_timing.unwrap_or(speech::WordTiming::None),
            }
            .sentences()
        } else {
            let mut segs = cache.segments.clone();
            segs.sort_by_key(|s| s.t_start_us);
            segs
        };
        let (w_start, w_end) = q.window.unwrap_or((i64::MIN, i64::MAX));
        let mut kept: Vec<speech::Segment> = view
            .into_iter()
            .filter(|s| s.t_start_us < w_end && s.t_end_us > w_start)
            .collect();
        if kept.is_empty() && q.backend.is_none() {
            // Covered nothing in this window — another engine's entry might.
            // (With an explicit `backend` the miss is the answer.)
            continue;
        }
        if q.compact {
            for s in &mut kept {
                s.words = Vec::new();
            }
        }
        return render_transcript(uri, &cache, backend, q, kept);
    }

    if q.backend.is_some() || cached_backends.is_empty() {
        let scope = match q.backend {
            Some(x) => format!(" under backend {}", x.as_str()),
            None => String::new(),
        };
        return Err(McpToolError::resource_not_found(
            format!(
                "no transcript cached yet for media {media_id}{scope} — call transcribe_clip (it persists on first transcribe)"
            ),
            None,
        ));
    }
    Err(McpToolError::resource_not_found(
        format!(
            "no transcript covering {} for media {media_id} (cached under {}) — transcribe that range, or widen the window",
            window_desc(q.window),
            cached_backends.join(", "),
        ),
        None,
    ))
}

/// The parsed `media://{id}/transcript` query. Every field optional; invalid
/// values refuse as `invalid_params` (a read the agent can fix mechanically),
/// never as silent defaults.
#[cfg(feature = "speech")]
struct TranscriptQuery {
    format: TranscriptFormat,
    sentence: bool,
    compact: bool,
    window: Option<(i64, i64)>,
    backend: Option<crate::speech::SpeechBackend>,
    language: Option<String>,
    want_words: bool,
}

#[cfg(feature = "speech")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum TranscriptFormat {
    Segments,
    Text,
    Srt,
}

#[cfg(feature = "speech")]
fn window_desc(window: Option<(i64, i64)>) -> String {
    match window {
        Some((s, e)) => format!("[{s}, {e})"),
        None => "the whole coverage".to_string(),
    }
}

#[cfg(feature = "speech")]
fn parse_transcript_query(query: &str) -> Result<TranscriptQuery, McpToolError> {
    use crate::speech::SpeechBackend;

    let mut format = TranscriptFormat::Segments;
    let mut segment: Option<&str> = None;
    let mut detail: Option<&str> = None;
    let mut w_start: Option<i64> = None;
    let mut w_end: Option<i64> = None;
    let mut backend: Option<SpeechBackend> = None;
    let mut language: Option<String> = None;
    let mut want_words = true;

    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').ok_or_else(|| {
            McpToolError::invalid_params(
                format!("transcript query pair without '=': {pair:?}"),
                None,
            )
        })?;
        match k {
            "format" => {
                format = match v {
                    "segments" => TranscriptFormat::Segments,
                    "text" => TranscriptFormat::Text,
                    "srt" => TranscriptFormat::Srt,
                    _ => {
                        return Err(McpToolError::invalid_params(
                            format!("transcript format {v:?}; expected \"segments\", \"text\", or \"srt\""),
                            None,
                        ));
                    }
                };
            }
            "segment" => {
                segment = Some(v);
                if !matches!(v, "sentence" | "engine") {
                    return Err(McpToolError::invalid_params(
                        format!("transcript segment {v:?}; expected \"sentence\" or \"engine\""),
                        None,
                    ));
                }
            }
            "detail" => {
                detail = Some(v);
                if !matches!(v, "full" | "compact") {
                    return Err(McpToolError::invalid_params(
                        format!("transcript detail {v:?}; expected \"full\" or \"compact\""),
                        None,
                    ));
                }
            }
            "t_start_us" => {
                w_start = Some(v.parse().map_err(|_| {
                    McpToolError::invalid_params(
                        format!("transcript t_start_us not an integer: {v:?}"),
                        None,
                    )
                })?);
            }
            "t_end_us" => {
                w_end = Some(v.parse().map_err(|_| {
                    McpToolError::invalid_params(
                        format!("transcript t_end_us not an integer: {v:?}"),
                        None,
                    )
                })?);
            }
            "backend" => {
                backend = Some(
                    SpeechBackend::all().iter().copied().find(|b| b.as_str() == v).ok_or_else(|| {
                        McpToolError::invalid_params(
                            format!("unknown backend {v:?}; expected \"openai\", \"whisper_cpp\", or \"funasr\""),
                            None,
                        )
                    })?,
                );
            }
            "language" => language = Some(v.to_string()),
            "words" => {
                want_words = match v {
                    "true" => true,
                    "false" => false,
                    _ => {
                        return Err(McpToolError::invalid_params(
                            format!("transcript words {v:?}; expected \"true\" or \"false\""),
                            None,
                        ));
                    }
                };
            }
            _ => {
                return Err(McpToolError::invalid_params(
                    format!("unknown transcript query key {k:?}"),
                    None,
                ));
            }
        }
    }
    if w_start.is_some() != w_end.is_some() {
        return Err(McpToolError::invalid_params(
            "transcript t_start_us and t_end_us name a window together — send both or neither"
                .to_string(),
            None,
        ));
    }
    let window = match (w_start, w_end) {
        (Some(s), Some(e)) => {
            if e <= s {
                return Err(McpToolError::invalid_params(
                    format!("transcript t_end_us ({e}) must be greater than t_start_us ({s})"),
                    None,
                ));
            }
            Some((s, e))
        }
        _ => None,
    };
    Ok(TranscriptQuery {
        format,
        sentence: segment.is_none_or(|s| s == "sentence"),
        compact: detail.is_some_and(|d| d == "compact"),
        window,
        backend,
        language,
        want_words,
    })
}

/// Render the windowed transcript view in the requested format: `segments`
/// returns the JSON envelope (`backend`, detected `language`, `word_timing`,
/// the `segment` view served, the source-absolute `range`, and the segments);
/// `text` the cue texts line-joined; `srt` the cues renumbered from 1.
#[cfg(feature = "speech")]
fn render_transcript(
    uri: &str,
    cache: &crate::speech::TranscriptCache,
    backend: crate::speech::SpeechBackend,
    q: TranscriptQuery,
    kept: Vec<crate::speech::Segment>,
) -> Result<ResourceResult, McpToolError> {
    use crate::speech;
    if q.format != TranscriptFormat::Segments {
        let mime = match q.format {
            TranscriptFormat::Text => "text/plain",
            _ => "application/x-subrip",
        };
        let text = match q.format {
            TranscriptFormat::Text => kept
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => speech::render_srt_segments(&kept),
        };
        return Ok(ResourceResult {
            contents: vec![ResourceContent::Text {
                uri: uri.to_string(),
                mime_type: Some(mime.to_string()),
                text,
            }],
        });
    }
    let range = if kept.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::json!({
            "t_start_us": kept.iter().map(|s| s.t_start_us).min(),
            "t_end_us": kept.iter().map(|s| s.t_end_us).max(),
        })
    };
    let body = serde_json::json!({
        "backend": backend.as_str(),
        "language": cache.language,
        "word_timing": cache.word_timing.unwrap_or(speech::WordTiming::None),
        "segment": if q.sentence { "sentence" } else { "engine" },
        "range": range,
        "segments": kept,
    });
    text_resource(uri, &body)
}

/// Serve `media://{id}/description` — the cached scene-description view the
/// app's own settings name (the preferred engine's backend + the injected
/// sampling, focus and language). Resolves the backend from the injected VLM
/// config, computes the same cache key `describe_clip` uses, and returns the
/// stored `DescriptionCache` (`{ covered_ranges, segments }`, source-absolute).
/// Reports a clear not-found when no backend is configured or nothing has been
/// described yet — unlike the always-computable analysis resources.
///
/// The view is INJECTED and not defaulted here, and that is the whole contract
/// this resource keeps: the host fills the tool's omitted `preferred_backend` /
/// `fps` / `focus` / `language` from one provider and injects the same four
/// values here, so the view a gesture writes is the view the shot rows read
/// back. Hardcoding any of them would strand every run at a non-default setting
/// in a view no read can find.
#[cfg(feature = "speech")]
async fn read_description_resource(
    b: &Backend,
    uri: &str,
    id_part: &str,
    media: Option<crate::state::MediaItem>,
    vlm_config: &std::collections::HashMap<String, crate::vlm::BackendConfig>,
    view: InjectedView<'_>,
) -> Result<ResourceResult, McpToolError> {
    use crate::vlm;

    let media_id = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;

    // The SAME preference-then-availability walk as describe_clip, preference
    // included: the resolved backend and its model label are two of the six
    // cache-key inputs, so a read that dropped the preference would look under
    // the entry a different engine wrote — the failure the other three axes are
    // injected to prevent, one field further along. An unknown tag (`"auto"`,
    // or a config from a build with another engine catalog) finds no backend
    // here and simply means "no preference", the way an omitted one does.
    let preferred = view.preferred.and_then(|tag| {
        vlm::VlmBackend::all()
            .iter()
            .copied()
            .find(|b| b.as_str() == tag)
    });
    let backend = vlm::resolve::select_backend(preferred, vlm_config).ok_or_else(|| {
        McpToolError::resource_not_found(
            format!(
                "no video-understanding backend configured — configure one, then call describe_clip for media {media_id}",
            ),
            None,
        )
    })?;
    // Every parse/fallback here is describe_clip's own, so an absent injection
    // resolves the way an omitted tool argument does.
    let language = vlm::Language::parse(view.language);
    let focus = vlm::Focus::parse(view.focus);
    let fps = view.fps.unwrap_or(vlm::DEFAULT_FPS);
    let key = vlm::cache_key(
        &media.file_hash_blake3,
        backend,
        &vlm::resolve::cache_model_identity(backend, vlm_config.get(backend.as_str())),
        vlm::fps_milli(fps),
        focus,
        &language,
    );
    let path = b.cache.description(&key);
    crate::cache::touch_if_stale(&path);
    if !crate::cache::cached_ok(&path) {
        // The whole VIEW is named in the refusal: change any of these and every
        // source reads as undescribed, and a sentence that named none of them
        // would make that look like lost data rather than a different view of the
        // same footage. Nothing is deleted on a switch — `descriptions/` is
        // excluded from the disk-LRU sweep — so the prior view is still there to
        // switch back to.
        return Err(McpToolError::resource_not_found(
            format!(
                "no description computed yet for media {media_id} ({}, {} fps, {} focus, {}) — call describe_clip",
                backend.as_str(),
                fps,
                focus.as_str(),
                language.as_str(),
            ),
            None,
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| McpToolError::internal_error(format!("read {}: {e}", path.display()), None))?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|e| McpToolError::internal_error(format!("parse description cache: {e}"), None))?;
    text_resource(uri, &body)
}

/// Serve `media://{id}/analysis` — the deterministic shot-layer view for the
/// tool's DEFAULT detection params (sensitivity 0.4, min_shot_us 500000, all
/// passes). Unlike `media://{id}/description`, the shot layer is ALWAYS
/// computable, so a cache miss COMPUTES on demand (a whole-source scan) and
/// writes it through, then returns — it never reports "not computed yet"
/// (mirrors `serve_frame`'s on-demand `jobs::extract_frame`). Idempotent pure
/// view: the same source + default params key the same VSHOT sidecar, so
/// repeated reads return byte-identical JSON; `analyze_clip` is the parameterized
/// recompute path that shares this cache. Returns the WHOLE-source `ShotReport`
/// (source-absolute times) — a media resource has no layer window to clip to.
#[cfg(feature = "jobs")]
async fn read_analysis_resource(
    b: &Backend,
    uri: &str,
    id_part: &str,
    media: Option<MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    let media_id = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_request(
            format!(
                "media {media_id} is not a video — media://{{id}}/analysis needs a video source"
            ),
            None,
        ));
    }
    // Default params mirror analyze_clip's defaults; source-keyed, so a layer's
    // analyze_clip with default args shares this exact cache entry.
    let opts = jobs::shot::ShotOpts {
        sensitivity: 0.4,
        min_shot_us: 500_000,
        stats: true,
        events: true,
    };
    let report = jobs::shot::cached_source_report(&b.cache, &media, &opts)
        .await
        .map_err(|e| McpToolError::internal_error(format!("shot analysis: {e:#}"), None))?;
    let body = serde_json::to_value(&report).map_err(serialize_err)?;
    text_resource(uri, &body)
}

#[cfg(feature = "jobs")]
async fn serve_thumbnail(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
) -> Result<ResourceResult, McpToolError> {
    // Pick the middle thumbnail (index 5) — agents asking for "show me
    // this clip" generally want a representative still, not the first
    // frame which is often a slate / black.
    const MID: usize = 5;
    let path = b.cache.thumbnail(&media.file_hash_blake3, MID);
    crate::cache::touch_if_stale(&path);
    if !cached_ok(&path) {
        return Err(McpToolError::resource_not_found(
            format!(
                "thumbnail not generated yet for media {} — wait for a media:job_complete event with kind=thumbnails, or read media://{}/frame/<t_us> for an on-demand extraction",
                media.id, media.id,
            ),
            None,
        ));
    }
    blob_response(uri, &path, IMAGE_JPEG).await
}

#[cfg(feature = "jobs")]
async fn serve_frame(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
    t_us: i64,
) -> Result<ResourceResult, McpToolError> {
    let path = jobs::extract_frame(&b.cache, media, t_us)
        .await
        .map_err(|e| McpToolError::internal_error(format!("frame extract: {e:#}"), None))?;
    blob_response(uri, &path, IMAGE_JPEG).await
}

#[cfg(feature = "jobs")]
async fn serve_waveform(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
) -> Result<ResourceResult, McpToolError> {
    let path = b.cache.waveform(&media.file_hash_blake3);
    crate::cache::touch_if_stale(&path);
    if !cached_ok(&path) {
        return Err(McpToolError::resource_not_found(
            format!(
                "waveform not generated yet for media {} — wait for a media:job_complete event with kind=waveform",
                media.id,
            ),
            None,
        ));
    }
    blob_response(uri, &path, APP_OCTET).await
}

#[cfg(feature = "jobs")]
async fn blob_response(
    uri: &str,
    path: &std::path::Path,
    mime: &str,
) -> Result<ResourceResult, McpToolError> {
    use base64::Engine;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| McpToolError::internal_error(format!("read {}: {e}", path.display()), None))?;
    let blob = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ResourceResult {
        contents: vec![ResourceContent::Blob {
            uri: uri.to_string(),
            mime_type: Some(mime.to_string()),
            blob,
        }],
    })
}

// ============================================================
// Static resource catalog
// ============================================================

struct ResourceDescriptor {
    uri: &'static str,
    name: &'static str,
    description: &'static str,
}

const STATIC_RESOURCES: &[ResourceDescriptor] = &[
    ResourceDescriptor {
        uri: URI_PROJECT,
        name: "Current project",
        description: "The full open WeftCut project as JSON. Re-fetch after change events.",
    },
    ResourceDescriptor {
        uri: URI_COMPOSITION,
        name: "Composition",
        description: "Canvas size, fps, sample rate, color space, background.",
    },
    ResourceDescriptor {
        uri: URI_MEDIA,
        name: "Media pool",
        description: "All imported media items keyed by id.",
    },
    ResourceDescriptor {
        uri: URI_TRACKS,
        name: "Tracks",
        description: "Tracks with layer envelopes. Read project://layers/{id} for full layer detail.",
    },
    ResourceDescriptor {
        uri: URI_TIMELINE,
        name: "Timeline",
        description: "Compact flat layer rows with a gap list. Takes ?composition=<id>, ?t_start_us=&t_end_us= (window, overlap), ?offset=&limit= (default 200, max 1000). Read project://layers/{id} for full layer detail.",
    },
    ResourceDescriptor {
        uri: URI_MARKERS,
        name: "Markers",
        description: "Timeline markers, sorted by t_us.",
    },
    ResourceDescriptor {
        uri: URI_COMPOSITIONS,
        name: "Compositions",
        description: "Every composition — the root and each Group — with id, label, duration_us and ref_count (how many CompositionRef layers place it). project://tracks?composition=<id> and project://markers?composition=<id> read one of them; unscoped they read the root.",
    },
    ResourceDescriptor {
        uri: URI_HISTORY,
        name: "History",
        description: "Recent operations and named checkpoints (no snapshots). `ops` is a window: `window_start` is the absolute stack index of `ops[0]`, and `cursor` is absolute too — never an offset into `ops`; absolute indices are the only ones `jump_to` accepts. `evicted` > 0 means the oldest entries were dropped for good.",
    },
    ResourceDescriptor {
        uri: URI_COMPILED,
        name: "Audio mix plan",
        description: "Compiled export-audio mix plan (layer placement on the 48 kHz frame grid + envelope summaries) — for agents that want structural reasoning about what export will mix.",
    },
    ResourceDescriptor {
        uri: URI_METER,
        name: "Audio meter",
        description: "Latest preview master-bus level reading (rms/peak dBFS). `live: false` when nothing has played in the last 2 seconds.",
    },
];

/// The advertised resource catalog (`resources/list`).
pub(super) fn static_resources() -> Vec<ResourceDef> {
    let out: Vec<ResourceDef> = STATIC_RESOURCES
        .iter()
        .map(|d| ResourceDef {
            uri: d.uri.to_string(),
            name: d.name.to_string(),
            description: d.description.to_string(),
            mime_type: APP_JSON.to_string(),
        })
        .collect();
    out
}

#[cfg(test)]
mod stateless_tests {
    use super::*;
    use crate::napi_backend::Backend;

    /// The injected field NAMES are the contract with
    /// `main/state/resource-views.ts`. A rename on either side degrades in
    /// silence — the reader falls back to the bare-core view, finds no entry
    /// under that key, and reports every source as undescribed with nothing to
    /// diagnose. The reader itself needs a `Backend` and a cache on disk, so
    /// what is pinned here is the shape it reads from.
    #[cfg(feature = "speech")]
    #[test]
    fn resource_state_reads_the_injected_describe_view() {
        let state: ResourceState = serde_json::from_str(
            r#"{"media":null,"vlm_config":{},"language":"zh-CN","describe_fps":2.5,"describe_focus":"shot-type"}"#,
        )
        .unwrap();
        assert_eq!(state.language.as_deref(), Some("zh-CN"));
        assert_eq!(state.describe_fps, Some(2.5));
        assert_eq!(state.describe_focus.as_deref(), Some("shot-type"));
        // A stateless read parses clean and injects nothing, so every axis falls
        // back the way an omitted tool argument does.
        let bare: ResourceState = serde_json::from_str("{}").unwrap();
        assert!(bare.language.is_none());
        assert!(bare.describe_fps.is_none());
        assert!(bare.describe_focus.is_none());
    }

    /// `transcribe_preferred` rides the same injection as the describe view's
    /// axes (and `"auto"` is the same absence): the transcript key carries the
    /// backend that served the request, so a read that dropped the preference
    /// would look under another engine's entry.
    #[cfg(feature = "speech")]
    #[test]
    fn resource_state_reads_the_injected_transcribe_preference() {
        let state: ResourceState =
            serde_json::from_str(r#"{"media":null,"transcribe_preferred":"whisper_cpp"}"#).unwrap();
        assert_eq!(state.transcribe_preferred.as_deref(), Some("whisper_cpp"));
        let bare: ResourceState = serde_json::from_str("{}").unwrap();
        assert!(bare.transcribe_preferred.is_none());
    }

    /// The advertised `project://history` description must teach the window
    /// semantics (`window_start`, `evicted`, absolute `jump_to` indices):
    /// several MCP clients surface only `resources/list` to the model, so a
    /// semantic that lives nowhere else is a semantic agents never see.
    #[test]
    fn history_description_carries_window_semantics() {
        let defs = static_resources();
        let d = defs.iter().find(|r| r.uri == URI_HISTORY).unwrap();
        for needle in ["window_start", "evicted", "jump_to"] {
            assert!(
                d.description.contains(needle),
                "project://history description lost `{needle}`"
            );
        }
    }

    /// project://compiled computes the audio mix plan from the INJECTED
    /// project, not a mirror. A blank project has no audio layers, so the plan
    /// is an empty layer list — proving the arm read `state.project`.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn compiled_uses_injected_project() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let p = crate::state::Project::new_blank("compiled-test");
        let state = serde_json::json!({ "project": p }).to_string();
        let r = read_resource(&b, URI_COMPILED, &state).await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["kind"], "audio_mix_plan");
        assert_eq!(
            body["layers"].as_array().unwrap().len(),
            0,
            "blank project has no audio layers"
        );
    }

    /// composition://meter reads live Rust state and needs no injected slice — an
    /// empty state JSON resolves to `live: false` (nothing has played).
    #[tokio::test]
    async fn meter_needs_no_state() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let r = read_resource(&b, URI_METER, "{}").await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["live"], false);
    }

    /// project://timeline is advertised here but served by the TS host (the
    /// sole state owner), like project://tracks: the catalog carries the
    /// entry so agents discover it, and this reader refuses the read with
    /// the TS-served message.
    #[test]
    fn timeline_is_advertised_but_ts_served() {
        let defs = static_resources();
        let d = defs
            .iter()
            .find(|r| r.uri == "project://timeline")
            .expect("project://timeline must be advertised");
        assert!(d.description.contains("?t_start_us="));
    }

    /// project://* state views are TS-served; the Rust reader returns a clear
    /// not-found.
    #[tokio::test]
    async fn project_views_are_not_served_by_rust() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let err = read_resource(&b, "project://current", "{}")
            .await
            .unwrap_err();
        assert!(
            err.message.contains("TS-served") || err.message.contains("unknown"),
            "project://current must report it is TS-served; got: {}",
            err.message
        );
    }

    /// media://* resolves from the INJECTED MediaItem. With a fabricated
    /// item whose thumbnail cache is empty, the reader reports "not generated yet"
    /// — proving it read `state.media` (it never touched the mirror).
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn media_resource_uses_injected_item() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = serde_json::json!({
            "id": id, "label": null, "path_abs": "/nonexistent", "path_rel": null,
            "kind": "Video", "metadata": crate::state::MediaMetadata::default(),
            "decode_route": { "route": "bypass" }, "waveform_path": null,
            "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": format!("test-{id}"), "file_size": 0, "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        });
        let state = serde_json::json!({ "media": item }).to_string();
        let uri = format!("media://{id}/thumbnail");
        let err = read_resource(&b, &uri, &state).await.unwrap_err();
        assert!(
            err.message.contains("not generated yet"),
            "media:// must read the injected item (cache empty → not generated yet); got: {}",
            err.message
        );
    }

    /// serve_thumbnail must touch the poster's mtime before reading it — the
    /// disk-LRU sweep keys a thumbnail dir's survival on its MAX contained
    /// mtime (`cache::disk_lru`), so an agent read that skips this call would
    /// look like "unused" and get evicted out from under a live MCP client.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn thumbnail_read_touches_stale_mtime() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let hash = format!("touch-test-{id}");
        let path = b.cache.thumbnail(&hash, 5);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"jpeg-bytes").unwrap();
        let stale = std::time::SystemTime::now()
            - crate::cache::TOUCH_THROTTLE
            - std::time::Duration::from_secs(60);
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(stale))
            .unwrap();

        let item = serde_json::json!({
            "id": id, "label": null, "path_abs": "/nonexistent", "path_rel": null,
            "kind": "Video", "metadata": crate::state::MediaMetadata::default(),
            "decode_route": { "route": "bypass" }, "waveform_path": null,
            "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": hash, "file_size": 0, "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        });
        let state = serde_json::json!({ "media": item }).to_string();
        let uri = format!("media://{id}/thumbnail");
        read_resource(&b, &uri, &state).await.unwrap();

        let m = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(
            m > stale + std::time::Duration::from_secs(30),
            "thumbnail read must refresh a stale poster mtime"
        );
    }

    /// Fabricate one transcribed source: an `openai` transcript key entry with
    /// two fragments 100 ms apart, so the default sentence view merges them.
    #[cfg(feature = "speech")]
    async fn write_transcript_fixture(b: &Backend, hash: &str) {
        use crate::speech::{BackendConfig, SpeechBackend};
        b.speech_config
            .lock()
            .expect("speech_config poisoned")
            .insert("openai".to_string(), BackendConfig::ApiKey("test-key".into()));
        let cache = serde_json::json!({
            "covered_ranges": [[0, 2_000_000]],
            "segments": [
                {"t_start_us": 0, "t_end_us": 500_000, "text": "hello",
                 "words": [{"t_start_us": 0, "t_end_us": 500_000, "text": "hello"}]},
                {"t_start_us": 600_000, "t_end_us": 1_000_000, "text": "world",
                 "words": [{"t_start_us": 600_000, "t_end_us": 1_000_000, "text": "world"}]},
            ],
            "language": "en",
            "word_timing": "exact",
        });
        let key = crate::speech::transcript_cache_key(
            hash,
            SpeechBackend::OpenAi.as_str(),
            &crate::speech::model_identity(
                SpeechBackend::OpenAi,
                Some(&BackendConfig::ApiKey("test-key".into())),
            ),
            None,
            true,
        );
        let dest = b.cache.transcript(&key);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, serde_json::to_vec(&cache).unwrap()).unwrap();
    }

    #[cfg(feature = "speech")]
    fn transcript_media_item(id: uuid::Uuid, hash: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "label": null, "path_abs": "/nonexistent", "path_rel": null,
            "kind": "Video",
            "metadata": {
                "duration_us": 2_000_000, "video": null,
                "audio": {"sample_rate": 48000, "channels": 2, "codec": "aac"},
                "container_format": null,
            },
            "decode_route": { "route": "bypass" }, "waveform_path": null,
            "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": hash, "file_size": 0, "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        })
    }

    #[cfg(feature = "speech")]
    fn transcript_body(r: &ResourceResult) -> serde_json::Value {
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            c => panic!("expected text content, got {c:?}"),
        };
        serde_json::from_str(&text).unwrap()
    }

    /// The durable-transcript read: no engine is spawned — a fabricated cache
    /// entry serves the default sentence view, the engine view, a window, the
    /// compact detail, and the srt format.
    #[cfg(feature = "speech")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcript_resource_serves_the_cached_transcript() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let hash = format!("transcript-test-{id}");
        write_transcript_fixture(&b, &hash).await;
        let state =
            serde_json::json!({ "media": transcript_media_item(id, &hash) }).to_string();

        let body = transcript_body(
            &read_resource(&b, &format!("media://{id}/transcript"), &state)
                .await
                .unwrap(),
        );
        assert_eq!(body["backend"], "openai");
        assert_eq!(body["segment"], "sentence");
        assert_eq!(body["language"], "en");
        assert_eq!(body["word_timing"], "exact");
        assert_eq!(body["segments"].as_array().unwrap().len(), 1);
        assert_eq!(body["segments"][0]["text"], "hello world");
        assert_eq!(body["segments"][0]["words"].as_array().unwrap().len(), 2);

        let engine = transcript_body(
            &read_resource(&b, &format!("media://{id}/transcript?segment=engine"), &state)
                .await
                .unwrap(),
        );
        assert_eq!(engine["segment"], "engine");
        assert_eq!(engine["segments"].as_array().unwrap().len(), 2);

        let windowed = transcript_body(
            &read_resource(
                &b,
                &format!("media://{id}/transcript?t_start_us=700000&t_end_us=2000000"),
                &state,
            )
            .await
            .unwrap(),
        );
        // The sentence straddles the window edge and belongs to both sides:
        // windowing never cuts it.
        assert_eq!(windowed["segments"].as_array().unwrap().len(), 1);

        let compact = transcript_body(
            &read_resource(&b, &format!("media://{id}/transcript?detail=compact"), &state)
                .await
                .unwrap(),
        );
        assert_eq!(compact["segments"][0]["words"].as_array().unwrap().len(), 0);

        let srt = read_resource(&b, &format!("media://{id}/transcript?format=srt"), &state)
            .await
            .unwrap();
        match &srt.contents[0] {
            ResourceContent::Text { text, mime_type, .. } => {
                assert_eq!(mime_type.as_deref(), Some("application/x-subrip"));
                assert!(text.starts_with("1\n00:00:00,000 --> 00:00:01,000\nhello world\n"));
            }
            c => panic!("expected text content, got {c:?}"),
        }
    }

    /// Before the first transcribe there is nothing to serve: the refusal
    /// names `transcribe_clip` (the call that fills the cache), not a retry.
    #[cfg(feature = "speech")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcript_resource_404s_before_the_first_transcribe() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let hash = format!("transcript-miss-{id}");
        let state =
            serde_json::json!({ "media": transcript_media_item(id, &hash) }).to_string();
        let err = read_resource(&b, &format!("media://{id}/transcript"), &state)
            .await
            .unwrap_err();
        assert!(
            err.message.contains("transcribe_clip"),
            "the miss must name the filling call; got: {}",
            err.message
        );
    }

    /// A source with no audio stream is refused outright (transcription could
    /// never have produced an entry), and a malformed query refuses as
    /// `invalid_params` rather than a silent default.
    #[cfg(feature = "speech")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcript_resource_refuses_audio_less_media_and_bad_queries() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let mut item = transcript_media_item(id, &format!("transcript-bad-{id}"));
        item["metadata"]["audio"] = serde_json::Value::Null;
        let state = serde_json::json!({ "media": item }).to_string();
        let err = read_resource(&b, &format!("media://{id}/transcript"), &state)
            .await
            .unwrap_err();
        assert!(err.message.contains("no audio stream"), "got: {}", err.message);

        let id2 = uuid::Uuid::now_v7();
        let hash2 = format!("transcript-bad-{id2}");
        let state2 =
            serde_json::json!({ "media": transcript_media_item(id2, &hash2) }).to_string();
        for uri in [
            format!("media://{id2}/transcript?format=nope"),
            format!("media://{id2}/transcript?segment=paragraph"),
            format!("media://{id2}/transcript?t_start_us=5"),
            format!("media://{id2}/transcript?backend=nope"),
        ] {
            let err = read_resource(&b, &uri, &state2).await.unwrap_err();
            assert_eq!(err.code, super::super::wire::McpErrorCode::InvalidParams, "{uri}: {}", err.message);
        }
    }
}
