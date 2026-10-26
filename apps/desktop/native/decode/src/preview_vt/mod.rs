//! macOS VideoToolbox → IOSurface → Electron shared-texture probe + the
//! ownership primitive the preview transport needs.
//!
//! The decoded frame's `CVPixelBufferRef` is retained in a small registry so
//! main can import its `IOSurfaceRef` via `sharedTexture.importSharedTexture`
//! and release it only after the import has taken its own reference. Nothing
//! here copies pixels: the IOSurface is the decoder's own output surface.
//! See `docs/preview.md` and the native-media-core plan.
#![cfg(target_os = "macos")]
#![allow(dead_code)]

mod session;
pub use session::{PreviewVtRegistry, VtPoke};

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::Mutex;

use ffmpeg_next::ffi as ffs;
use ffmpeg_next::format::input;
use ffmpeg_next::media::Type;
use ffmpeg_next::util::frame::video::Video as VideoFrame;

use crate::media_time::{ticks_to_source_us, ticks_to_us};
use crate::preview_sw::decoder::SwColorTags;

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferGetIOSurface(pixel_buffer: *mut c_void) -> *mut c_void;
    fn CVPixelBufferGetWidth(pixel_buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(pixel_buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetPixelFormatType(pixel_buffer: *mut c_void) -> u32;
    fn CVPixelBufferRetain(pixel_buffer: *mut c_void) -> *mut c_void;
    fn CVPixelBufferRelease(pixel_buffer: *mut c_void);
}

#[link(name = "IOSurface", kind = "framework")]
extern "C" {
    fn IOSurfaceGetID(buffer: *mut c_void) -> u32;
}

/// '420v' (video-range NV12) / '420f' (full-range NV12) and the two P010
/// fourccs: 'x420' (video range) / 'xf44' (full range).
const K_CV_PIXEL_FORMAT_420V: u32 = 0x3432_3076;
const K_CV_PIXEL_FORMAT_420F: u32 = 0x3432_3066;
const K_CV_PIXEL_FORMAT_X420: u32 = 0x7834_3230;
const K_CV_PIXEL_FORMAT_XF44: u32 = 0x7866_3434;

#[derive(Debug)]
pub struct VtSurface {
    pub id: u64,
    pub pixel_buffer: usize,
    pub io_surface: usize,
    pub io_surface_id: u32,
    pub width: u32,
    pub height: u32,
    /// Electron's `pixelFormat` vocabulary: "nv12" | "p010le".
    pub pixel_format: &'static str,
    pub full_range: bool,
    pub pts_us: i64,
    pub dur_us: i64,
    pub color: SwColorTags,
}

unsafe impl Send for VtSurface {}

/// Retained CVPixelBuffers, keyed by the id JS receives. `usize` (not the raw
/// pointer type) keeps the registry `Send`; the CF type itself is retained and
/// therefore outlives this map entry until `release_surface`.
static RETAINED: Mutex<Option<HashMap<u64, usize>>> = Mutex::new(None);
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn retained() -> std::sync::MutexGuard<'static, Option<HashMap<u64, usize>>> {
    match RETAINED.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

pub fn release_pixel_buffer(ptr: usize) {
    unsafe { CVPixelBufferRelease(ptr as *mut c_void) };
}

pub fn release_surface(id: u64) {
    let ptr = retained().as_mut().and_then(|m| m.remove(&id));
    if let Some(p) = ptr {
        unsafe { CVPixelBufferRelease(p as *mut c_void) };
    }
}

pub fn release_all_surfaces() {
    if let Some(m) = retained().as_mut() {
        for (_, p) in m.drain() {
            unsafe { CVPixelBufferRelease(p as *mut c_void) };
        }
    }
}

fn cv_info(pixel_buffer: *mut c_void) -> Result<(u32, u32, &'static str, bool), String> {
    let io = unsafe { CVPixelBufferGetIOSurface(pixel_buffer) };
    if io.is_null() {
        return Err("VideoToolbox frame has no IOSurface".into());
    }
    let fmt = unsafe { CVPixelBufferGetPixelFormatType(pixel_buffer) };
    let (name, full_range) = match fmt {
        K_CV_PIXEL_FORMAT_420V => ("nv12", false),
        K_CV_PIXEL_FORMAT_420F => ("nv12", true),
        K_CV_PIXEL_FORMAT_X420 => ("p010le", false),
        K_CV_PIXEL_FORMAT_XF44 => ("p010le", true),
        other => {
            return Err(format!(
                "unsupported VideoToolbox CVPixelBuffer format 0x{other:08x}"
            ))
        }
    };
    Ok((
        unsafe { CVPixelBufferGetWidth(pixel_buffer) } as u32,
        unsafe { CVPixelBufferGetHeight(pixel_buffer) } as u32,
        name,
        full_range,
    ))
}

unsafe extern "C" fn get_format_videotoolbox(
    _ctx: *mut ffs::AVCodecContext,
    pix_fmts: *const ffs::AVPixelFormat,
) -> ffs::AVPixelFormat {
    let mut p = pix_fmts;
    while unsafe { *p } != ffs::AVPixelFormat::AV_PIX_FMT_NONE {
        if unsafe { *p } == ffs::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX {
            return ffs::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX;
        }
        p = unsafe { p.add(1) };
    }
    unsafe { *pix_fmts }
}

/// One retained VideoToolbox output surface (no copied planes). The CVPixelBuffer
/// reference is owned by the caller and must be released with `CVPixelBufferRelease`
/// (the session's ack path) or `release_surface`.
#[derive(Debug)]
pub struct VtFrameSurface {
    pub pixel_buffer: usize,
    pub io_surface: usize,
    pub io_surface_id: u32,
    pub width: u32,
    pub height: u32,
    pub pixel_format: &'static str,
    pub full_range: bool,
    pub pts_us: i64,
    pub dur_us: i64,
}

unsafe impl Send for VtFrameSurface {}

/// Retain the CVPixelBuffer/IOSurface of a decoded `AV_PIX_FMT_VIDEOTOOLBOX`
/// frame. `frame` must be a live frame whose `data[3]` is the CVPixelBuffer.
/// The returned surface outlives the AVFrame; release it when the renderer has
/// acked.
pub unsafe fn retain_surface_from_frame(
    frame: *const ffs::AVFrame,
    time_base: (i32, i32),
    start_pts_us: i64,
) -> Result<VtFrameSurface, String> {
    if frame.is_null() {
        return Err("null AVFrame".into());
    }
    let fmt = (*frame).format;
    if fmt != ffs::AVPixelFormat::AV_PIX_FMT_VIDEOTOOLBOX as i32 {
        return Err(format!(
            "frame is {fmt:?}, not VideoToolbox (hardware decode unavailable)"
        ));
    }
    let pixel_buffer = (*frame).data[3] as *mut c_void;
    if pixel_buffer.is_null() {
        return Err("VideoToolbox frame has no CVPixelBuffer".into());
    }
    let (width, height, pixel_format, full_range) = cv_info(pixel_buffer)?;
    let io_surface = CVPixelBufferGetIOSurface(pixel_buffer);
    let io_surface_id = IOSurfaceGetID(io_surface);
    let pts = if (*frame).pts != ffs::AV_NOPTS_VALUE {
        (*frame).pts
    } else {
        (*frame).best_effort_timestamp
    };
    let pts_us = ticks_to_source_us(pts, time_base, start_pts_us);
    let dur_us = ticks_to_us((*frame).duration, time_base);
    CVPixelBufferRetain(pixel_buffer);
    Ok(VtFrameSurface {
        pixel_buffer: pixel_buffer as usize,
        io_surface: io_surface as usize,
        io_surface_id,
        width,
        height,
        pixel_format,
        full_range,
        pts_us,
        dur_us,
    })
}

/// Decode the first VideoToolbox frame and retain its CVPixelBuffer/IOSurface.
/// The caller must `release_surface(id)` after Electron has imported the handle
/// (or on teardown). No CPU transfer happens.
pub fn decode_first_surface(path: &str) -> Result<VtSurface, String> {
    ffmpeg_next::init().ok();
    let map = |e: ffmpeg_next::Error| e.to_string();

    let mut ictx = input(path).map_err(map)?;
    let stream = ictx
        .streams()
        .best(Type::Video)
        .ok_or_else(|| "no video stream".to_string())?;
    let stream_index = stream.index();
    let time_base = (
        stream.time_base().numerator(),
        stream.time_base().denominator(),
    );
    let start_time_raw = stream.start_time();
    let start_pts_us = if start_time_raw != ffs::AV_NOPTS_VALUE {
        ticks_to_us(start_time_raw, time_base)
    } else {
        0
    };
    let mut codec_ctx =
        ffmpeg_next::codec::context::Context::from_parameters(stream.parameters()).map_err(map)?;

    let mut hw_ctx: *mut ffs::AVBufferRef = ptr::null_mut();
    unsafe {
        let ret = ffs::av_hwdevice_ctx_create(
            &mut hw_ctx,
            ffs::AVHWDeviceType::AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
            ptr::null(),
            ptr::null_mut(),
            0,
        );
        if ret < 0 || hw_ctx.is_null() {
            return Err(format!(
                "av_hwdevice_ctx_create(videotoolbox) failed (ret={ret})"
            ));
        }
        let raw = codec_ctx.as_mut_ptr();
        (*raw).hw_device_ctx = ffs::av_buffer_ref(hw_ctx);
        (*raw).get_format = Some(get_format_videotoolbox);
    }
    let mut decoder = match codec_ctx.decoder().video() {
        Ok(d) => d,
        Err(e) => {
            unsafe { ffs::av_buffer_unref(&mut hw_ctx) };
            return Err(map(e));
        }
    };
    let color = SwColorTags {
        matrix: decoder.color_space().name().map(|s| s.to_string()),
        range: decoder.color_range().name().map(|s| s.to_string()),
        primaries: decoder.color_primaries().name().map(|s| s.to_string()),
        transfer: decoder
            .color_transfer_characteristic()
            .name()
            .map(|s| s.to_string()),
    };

    let mut frame = VideoFrame::empty();
    let got = loop {
        if decoder.receive_frame(&mut frame).is_ok() {
            break true;
        }
        match ictx.packets().next() {
            Some((s, p)) => {
                if s.index() == stream_index {
                    decoder.send_packet(&p).map_err(map)?;
                }
            }
            None => {
                decoder.send_eof().map_err(map)?;
                break decoder.receive_frame(&mut frame).is_ok();
            }
        }
    };
    if !got {
        unsafe { ffs::av_buffer_unref(&mut hw_ctx) };
        return Err("no frame decoded".into());
    }
    let surface =
        match unsafe { retain_surface_from_frame(frame.as_ptr(), time_base, start_pts_us) } {
            Ok(s) => s,
            Err(e) => {
                unsafe { ffs::av_buffer_unref(&mut hw_ctx) };
                return Err(e);
            }
        };
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    {
        let mut guard = retained();
        guard
            .get_or_insert_with(HashMap::new)
            .insert(id, surface.pixel_buffer);
    }
    unsafe { ffs::av_buffer_unref(&mut hw_ctx) };
    drop(frame);
    drop(decoder);
    drop(ictx);

    Ok(VtSurface {
        id,
        pixel_buffer: surface.pixel_buffer,
        io_surface: surface.io_surface,
        io_surface_id: surface.io_surface_id,
        width: surface.width,
        height: surface.height,
        pixel_format: surface.pixel_format,
        full_range: surface.full_range,
        pts_us: surface.pts_us,
        dur_us: surface.dur_us,
        color,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn videotoolbox_frame_exposes_a_retained_iosurface() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_h264.mp4");
        let s = decode_first_surface(p).expect("videotoolbox first frame");
        assert!(s.io_surface != 0, "no IOSurface");
        assert!(s.io_surface_id != 0, "IOSurface has no global id");
        assert_eq!(s.pixel_format, "nv12");
        assert!(s.width > 0 && s.height > 0);
        // The retained pixel buffer must survive the decoded frame's drop.
        let again = unsafe { CVPixelBufferGetIOSurface(s.pixel_buffer as *mut c_void) };
        assert!(!again.is_null());
        release_surface(s.id);
    }
}
