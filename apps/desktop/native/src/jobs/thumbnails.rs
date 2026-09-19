//! Thumbnail extraction: one ffmpeg invocation per poster seeks to a
//! `THUMB_COUNT`-even bucket midpoint and grabs a single frame, scaled to
//! `THUMB_WIDTH` (aspect kept).
//!
//! Cache layout: `<cache>/thumbnails/<file_hash>/000.jpg ..`; a set counts as
//! cached only when every JPG is present and non-empty.

use std::path::PathBuf;
use std::process::Stdio;

use crate::ffmpeg::ffmpeg_is_installed;
use anyhow::{anyhow, Context, Result};

use crate::cache::{cached_ok, CacheLayout};
use crate::jobs::hwaccel;
use crate::state::MediaItem;

const THUMB_COUNT: usize = 10;
const THUMB_WIDTH: u32 = 320;
/// Below this, the per-poster buckets collapse onto the same frame. Skip
/// thumbnail generation for these.
const MIN_DURATION_US: i64 = 100_000;

pub async fn run(cache: &CacheLayout, media: &MediaItem) -> Result<PathBuf> {
    if !ffmpeg_is_installed() {
        anyhow::bail!("ffmpeg not installed; cannot generate thumbnails");
    }
    let duration_us = media
        .metadata
        .duration_us
        .ok_or_else(|| anyhow!("media has no duration; cannot space thumbnails"))?;
    if duration_us < MIN_DURATION_US {
        anyhow::bail!(
            "media duration {duration_us}us is below thumbnail minimum {MIN_DURATION_US}us"
        );
    }

    let hash = &media.file_hash_blake3;
    let dest_dir = cache.thumbnails(hash);

    if all_thumbnails_present(cache, hash) {
        return Ok(dest_dir);
    }

    // Fresh + temp dir alongside, atomic-ish: write into `<dest>.tmp/` then
    // rename. We don't use `cache::temp_path` directly because that's for
    // single files; for a directory of N JPGs we manage the .tmp dir
    // ourselves.
    let tmp_dir = {
        let mut s = dest_dir.as_os_str().to_owned();
        s.push(".tmp");
        PathBuf::from(s)
    };

    // Cleanup any prior interrupted attempt.
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .with_context(|| format!("create thumbnails tmp dir {}", tmp_dir.display()))?;

    let duration_s = duration_us as f64 / 1_000_000.0;

    // `-ss` at or past the last frame makes ffmpeg hand the mjpeg encoder an
    // EOF frame it refuses ("Non full-range YUV is non-standard, set
    // strict_std_compliance…"), so clamp every seek one frame inside the
    // source — mirrors filmstrip's TAIL_SLACK_US. Falls back to 100 ms when
    // the probe carried no fps.
    let tail_slack_s = media
        .metadata
        .video
        .as_ref()
        .filter(|v| v.fps_num > 0 && v.fps_den > 0)
        .map(|v| v.fps_den as f64 / v.fps_num as f64)
        .unwrap_or(0.1);
    let max_seek_s = (duration_s - tail_slack_s).max(0.0);

    // One seek-and-grab per poster. `-ss` BEFORE `-i` is the fast seek (see
    // jobs/frame.rs): ffmpeg jumps to the nearest keyframe and walks to the
    // timestamp. The previous shape fed a single `fps=THUMB_COUNT/duration`
    // filter, which is NOT a seek — it decodes the whole source from t=0 and
    // discards all but THUMB_COUNT frames (minutes of every-core CPU on a long
    // 4K source). `output_with_hw_decode_fallback` also hardware-decodes when
    // the platform offers it, with a software retry. -an drops audio; -q:v 5
    // is a mid-quality JPG; -update 1 + -f image2 writes one file per seek.
    for i in 0..THUMB_COUNT {
        // Sample the middle of each of the THUMB_COUNT even buckets, so the
        // set spans the clip without landing on a boundary frame, then clamp
        // inside the source so the tail bucket can't seek past the last frame.
        let t_seconds = (duration_s * (i as f64 + 0.5) / THUMB_COUNT as f64).min(max_seek_s);
        let out_path = tmp_dir.join(format!("{i:03}.jpg"));

        let output = hwaccel::output_with_hw_decode_fallback("thumbnails", |use_hw, cmd| {
            cmd.args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"]);
            if use_hw {
                hwaccel::push_hwaccel_args(cmd);
            }
            cmd.args(["-ss", &format!("{t_seconds}")])
                .arg("-i")
                .arg(&media.path_abs)
                .args([
                    "-frames:v",
                    "1",
                    "-vf",
                    &format!("scale={THUMB_WIDTH}:-2"),
                    "-q:v",
                    "5",
                    "-update",
                    "1",
                    "-f",
                    "image2",
                ])
                .arg(&out_path)
                .stdin(Stdio::null());
        })
        .await
        .context("spawn ffmpeg for thumbnails")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            anyhow::bail!(
                "ffmpeg exited with {} for thumbnail {i}: {}",
                output.status,
                stderr.trim()
            );
        }
    }

    // Verify every poster landed non-empty before promoting.
    for i in 0..THUMB_COUNT {
        let p = tmp_dir.join(format!("{i:03}.jpg"));
        if !cached_ok(&p) {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            anyhow::bail!(
                "ffmpeg produced incomplete thumbnail set at {}",
                tmp_dir.display()
            );
        }
    }

    // Promote: dest_dir might exist as a stale partial — wipe + rename.
    let _ = tokio::fs::remove_dir_all(&dest_dir).await;
    tokio::fs::rename(&tmp_dir, &dest_dir)
        .await
        .with_context(|| format!("promote {} -> {}", tmp_dir.display(), dest_dir.display()))?;

    cache.notify_write();
    Ok(dest_dir)
}

fn all_thumbnails_present(cache: &CacheLayout, hash: &str) -> bool {
    (0..THUMB_COUNT).all(|i| cached_ok(&cache.thumbnail(hash, i)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;
    use tokio::process::Command;

    use crate::state::{new_id, DecodeRoute, MediaKind, MediaMetadata};

    fn ffmpeg_available() -> bool {
        StdCommand::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Generate a tiny 1-second mp4 via lavfi `testsrc` so the smoke test
    /// has real bytes to operate on without committing a video fixture.
    async fn make_test_video(dest: &std::path::Path) -> Result<()> {
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=320x180:rate=10",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-t",
                "1",
            ])
            .arg(dest)
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("test fixture ffmpeg failed: {status}");
        }
        Ok(())
    }

    #[tokio::test]
    async fn thumbnails_roundtrip_against_real_ffmpeg() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping thumbnails smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let video = tmp.path().join("source.mp4");
        make_test_video(&video).await.expect("test fixture");

        let media = MediaItem {
            id: new_id(),
            label: Some("source.mp4".into()),
            path_abs: video,
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let dir = run(&cache, &media).await.expect("thumbnails run");
        for i in 0..THUMB_COUNT {
            let p = dir.join(format!("{:03}.jpg", i));
            assert!(cached_ok(&p), "missing thumbnail {p:?}");
        }
    }

    #[tokio::test]
    async fn skip_when_already_cached() {
        if !ffmpeg_available() {
            eprintln!("ffmpeg not on PATH — skipping thumbnails skip-cache smoke");
            return;
        }
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        // Pre-populate the cache with the 10 non-zero JPGs the run expects.
        let hash = "preexist";
        let dir = cache.thumbnails(hash);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for i in 0..THUMB_COUNT {
            tokio::fs::write(dir.join(format!("{:03}.jpg", i)), b"fake")
                .await
                .unwrap();
        }

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("nope.mp4"), // never read because cache hits
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: hash.into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let returned = run(&cache, &media).await.expect("cache hit");
        assert_eq!(returned, dir);
    }

    #[tokio::test]
    async fn rejects_below_minimum_duration() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().join("cache"));
        cache.ensure_dirs().unwrap();

        let media = MediaItem {
            id: new_id(),
            label: None,
            path_abs: tmp.path().join("tiny.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(50_000), // 50ms — below MIN_DURATION_US
                video: None,
                audio: None,
                ..Default::default()
            },
            decode_route: DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "tiny".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };

        let err = run(&cache, &media).await.expect_err("too-short clip");
        assert!(
            format!("{err:#}").contains("below thumbnail minimum"),
            "wrong error: {err:#}"
        );
    }
}
