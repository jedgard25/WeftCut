//! Per-stream VideoToolbox preview session that shares decoded IOSurfaces with
//! Electron instead of copying pixels to CPU.
//!
//! Contract (mirrors the Windows `preview_gpu` transport):
//! - `open` spawns a thread that owns the `SwVideoStream` (VideoToolbox).
//! - The thread decodes on demand. The FIRST time an IOSurface is seen it emits
//!   `Slot { handle, pixelFormat, … }`; main imports that IOSurface into
//!   Electron once. Every delivered frame then emits a tiny `FrameReady` poke.
//! - The decoded CVPixelBuffer is retained until the renderer acks the
//!   (slot, gen) pair, which is what prevents VideoToolbox from recycling the
//!   surface while Chromium is reading it.
//! - No per-frame pixels cross IPC. The only per-frame traffic is the poke.
//! - A bounded outstanding window stops a stalled renderer from pinning an
//!   unbounded number of decoder surfaces; a lease timeout drops a frame rather
//!   than wedging the session forever.
#![cfg(target_os = "macos")]
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::preview_sw::decoder::{DecodeAccel, OutScale, SwOutFormat, SwVideoStream};
use crate::preview_vt::{release_pixel_buffer, VtFrameSurface};
use crate::recover::LockExt;

const LOOKAHEAD_US: i64 = 500_000;
const FORWARD_CONTINUE_US: i64 = 1_000_000;
const MAX_BURST_FRAMES: usize = 8;
const MAX_OUTSTANDING: usize = 6;
const LEASE_TIMEOUT: Duration = Duration::from_secs(3);
const RECV_TIMEOUT: Duration = Duration::from_millis(4);
const CLOSE_GRACE: Duration = Duration::from_millis(300);

#[derive(Debug)]
pub enum VtPoke {
    Slot {
        stream_id: String,
        slot: u32,
        /// Hex of the native-endian `IOSurfaceRef` value; main turns it into the
        /// `ioSurface` Buffer Electron's importer expects.
        handle: String,
        width: u32,
        height: u32,
        pixel_format: String,
        full_range: bool,
    },
    FrameReady {
        stream_id: String,
        slot: u32,
        gen: u32,
        pts_us: i64,
        dur_us: i64,
    },
    Eof {
        stream_id: String,
    },
    Error {
        stream_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct OpenInfo {
    pub width: u32,
    pub height: u32,
}

type Sink = Arc<Mutex<Option<Box<dyn Fn(VtPoke) + Send>>>>;

fn emit(sink: &Sink, poke: VtPoke) {
    let guard = sink.lock_recover();
    if let Some(f) = guard.as_ref() {
        f(poke);
    }
}

enum Msg {
    Request { target_us: i64 },
    Ack { slot: u32, gen: u32 },
    Close,
}

struct Session {
    tx: Sender<Msg>,
    shutdown: Arc<AtomicBool>,
    done_rx: Receiver<()>,
    join: Option<JoinHandle<()>>,
}

struct SlotInfo {
    slot: u32,
    width: u32,
    height: u32,
    pixel_format: &'static str,
    full_range: bool,
}

struct Held {
    pixel_buffer: usize,
    at: Instant,
}

/// Everything the session thread owns. The decoder itself is separate because
/// it is `!Send`; this state is plain data.
struct State {
    /// Keyed by (IOSurfaceRef, IOSurfaceID): the pointer alone can be reused by
    /// a recycled surface, and the ID alone can collide across pools.
    slots: HashMap<(usize, u32), SlotInfo>,
    next_slot: u32,
    next_gen: u32,
    held: HashMap<(u32, u32), Held>,
    latest_request: Option<i64>,
    last_target_us: Option<i64>,
    frontier_us: i64,
    ended: bool,
    eof_sent: bool,
}

impl State {
    fn new() -> Self {
        Self {
            slots: HashMap::new(),
            next_slot: 0,
            next_gen: 1,
            held: HashMap::new(),
            latest_request: None,
            last_target_us: None,
            frontier_us: i64::MIN / 2,
            ended: false,
            eof_sent: false,
        }
    }

    fn release_expired(&mut self) {
        let now = Instant::now();
        let stale: Vec<(u32, u32)> = self
            .held
            .iter()
            .filter(|(_, h)| now.duration_since(h.at) >= LEASE_TIMEOUT)
            .map(|(k, _)| *k)
            .collect();
        for key in stale {
            if let Some(h) = self.held.remove(&key) {
                release_pixel_buffer(h.pixel_buffer);
            }
        }
    }

    fn release_all(&mut self) {
        for (_, h) in self.held.drain() {
            release_pixel_buffer(h.pixel_buffer);
        }
    }

    fn deliver(&mut self, surface: VtFrameSurface, sink: &Sink, stream_id: &str) {
        let key = (surface.io_surface, surface.io_surface_id);
        let (slot, is_new) = match self.slots.get(&key) {
            Some(info) => (info.slot, false),
            None => {
                let slot = self.next_slot;
                self.next_slot = self.next_slot.wrapping_add(1);
                self.slots.insert(
                    key,
                    SlotInfo {
                        slot,
                        width: surface.width,
                        height: surface.height,
                        pixel_format: surface.pixel_format,
                        full_range: surface.full_range,
                    },
                );
                (slot, true)
            }
        };
        if is_new {
            let info = self.slots.get(&key).expect("just inserted");
            let bytes = (surface.io_surface as u64).to_le_bytes();
            let handle = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
            emit(
                sink,
                VtPoke::Slot {
                    stream_id: stream_id.to_string(),
                    slot,
                    handle,
                    width: info.width,
                    height: info.height,
                    pixel_format: info.pixel_format.to_string(),
                    full_range: info.full_range,
                },
            );
        }
        let gen = self.next_gen;
        self.next_gen = self.next_gen.wrapping_add(1);
        self.held.insert(
            (slot, gen),
            Held {
                pixel_buffer: surface.pixel_buffer,
                at: Instant::now(),
            },
        );
        emit(
            sink,
            VtPoke::FrameReady {
                stream_id: stream_id.to_string(),
                slot,
                gen,
                pts_us: surface.pts_us,
                dur_us: surface.dur_us,
            },
        );
    }
}

/// Drain queued commands without blocking. Returns true for `Close`.
fn drain_commands(rx: &Receiver<Msg>, state: &mut State, first: Option<Msg>) -> bool {
    let handle = |msg: Msg, state: &mut State| -> bool {
        match msg {
            Msg::Ack { slot, gen } => {
                if let Some(h) = state.held.remove(&(slot, gen)) {
                    release_pixel_buffer(h.pixel_buffer);
                }
                false
            }
            Msg::Request { target_us } => {
                state.latest_request = Some(target_us);
                false
            }
            Msg::Close => true,
        }
    };
    if let Some(msg) = first {
        if handle(msg, state) {
            return true;
        }
    }
    loop {
        match rx.try_recv() {
            Ok(msg) => {
                if handle(msg, state) {
                    return true;
                }
            }
            Err(_) => return false,
        }
    }
}

enum ServeOutcome {
    Done,
    Paused,
    Closed,
}

#[allow(clippy::too_many_arguments)]
fn serve(
    stream: &mut SwVideoStream,
    state: &mut State,
    target_us: i64,
    sink: &Sink,
    stream_id: &str,
    shutdown: &AtomicBool,
    rx: &Receiver<Msg>,
) -> ServeOutcome {
    let forward = state.last_target_us.is_some_and(|lt| {
        !state.ended
            && target_us >= lt
            && target_us.saturating_sub(state.frontier_us) <= FORWARD_CONTINUE_US
    });
    if !forward {
        if shutdown.load(Ordering::Acquire) {
            return ServeOutcome::Closed;
        }
        if let Err(e) = stream.seek(target_us) {
            emit(
                sink,
                VtPoke::Error {
                    stream_id: stream_id.to_string(),
                    message: format!("videotoolbox seek to {target_us}us failed: {e}"),
                },
            );
            state.ended = true;
            return ServeOutcome::Done;
        }
        state.ended = false;
        state.eof_sent = false;
        state.frontier_us = target_us;
    }
    state.last_target_us = Some(target_us);
    let mut delivered = 0usize;
    loop {
        if shutdown.load(Ordering::Acquire) {
            return ServeOutcome::Closed;
        }
        if drain_commands(rx, state, None) {
            return ServeOutcome::Closed;
        }
        state.release_expired();
        // A newer request supersedes this burst; the outer loop serves it.
        if let Some(next) = state.latest_request.take() {
            if next != target_us {
                // Preserve it for the outer loop; dropping it here would
                // silently swallow a newer scrub target.
                state.latest_request = Some(next);
                return ServeOutcome::Paused;
            }
        }
        if state.held.len() >= MAX_OUTSTANDING {
            return ServeOutcome::Paused;
        }
        if state.frontier_us >= target_us.saturating_add(LOOKAHEAD_US) {
            return ServeOutcome::Done;
        }
        match stream.next_frame_surface() {
            Ok(Some(surface)) => {
                state.frontier_us = surface.pts_us;
                if surface.pts_us < target_us {
                    // GOP prefix after a seek: references only, not shown.
                    release_pixel_buffer(surface.pixel_buffer);
                    continue;
                }
                state.deliver(surface, sink, stream_id);
                delivered += 1;
                if delivered >= MAX_BURST_FRAMES {
                    return ServeOutcome::Paused;
                }
            }
            Ok(None) => {
                state.ended = true;
                if !state.eof_sent {
                    state.eof_sent = true;
                    emit(
                        sink,
                        VtPoke::Eof {
                            stream_id: stream_id.to_string(),
                        },
                    );
                }
                return ServeOutcome::Done;
            }
            Err(e) => {
                state.ended = true;
                emit(
                    sink,
                    VtPoke::Error {
                        stream_id: stream_id.to_string(),
                        message: format!("videotoolbox decode failed: {e}"),
                    },
                );
                return ServeOutcome::Done;
            }
        }
    }
}

fn session_thread(
    stream_id: String,
    path: String,
    sink: Sink,
    rx: Receiver<Msg>,
    shutdown: Arc<AtomicBool>,
    init_tx: Sender<Result<OpenInfo, String>>,
    done_tx: Sender<()>,
) {
    let stream = SwVideoStream::open_with_accel(
        &path,
        SwOutFormat::Nv12,
        DecodeAccel::VideoToolbox,
        OutScale::FULL,
    );
    let mut stream = match stream {
        Ok(s) => {
            let _ = init_tx.send(Ok(OpenInfo {
                width: s.width,
                height: s.height,
            }));
            s
        }
        Err(e) => {
            let _ = init_tx.send(Err(e));
            drop(done_tx);
            return;
        }
    };
    let mut state = State::new();
    loop {
        let first = match rx.recv_timeout(RECV_TIMEOUT) {
            Ok(msg) => Some(msg),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if drain_commands(&rx, &mut state, first) || shutdown.load(Ordering::Acquire) {
            break;
        }
        let Some(target) = state.latest_request.take() else {
            continue;
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            serve(
                &mut stream,
                &mut state,
                target,
                &sink,
                &stream_id,
                &shutdown,
                &rx,
            )
        }));
        match outcome {
            Ok(ServeOutcome::Closed) => break,
            Ok(ServeOutcome::Done) | Ok(ServeOutcome::Paused) => {}
            Err(payload) => {
                emit(
                    &sink,
                    VtPoke::Error {
                        stream_id,
                        message: format!(
                            "videotoolbox preview panicked: {}",
                            crate::recover::panic_message(&*payload)
                        ),
                    },
                );
                break;
            }
        }
    }
    state.release_all();
    drop(stream);
    drop(done_tx);
}

/// Live VideoToolbox preview sessions. `Send + Sync`; held by the addon.
pub struct PreviewVtRegistry {
    sessions: Mutex<HashMap<String, Session>>,
    sink: Sink,
}

impl Default for PreviewVtRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviewVtRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            sink: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_poke_sink(&self, sink: Box<dyn Fn(VtPoke) + Send>) {
        *self.sink.lock_recover() = Some(sink);
    }

    pub fn open(&self, stream_id: &str, path: &str) -> Result<OpenInfo, String> {
        let mut sessions = self.sessions.lock_recover();
        if sessions.contains_key(stream_id) {
            return Err(format!("preview-vt session '{stream_id}' is already open"));
        }
        let (init_tx, init_rx) = mpsc::channel::<Result<OpenInfo, String>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Msg>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let sink = Arc::clone(&self.sink);
        let sid = stream_id.to_string();
        let path_owned = path.to_string();
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = Arc::clone(&shutdown);
        let join = thread::Builder::new()
            .name(format!("preview-vt-{stream_id}"))
            .spawn(move || {
                session_thread(
                    sid,
                    path_owned,
                    sink,
                    cmd_rx,
                    shutdown_for_thread,
                    init_tx,
                    done_tx,
                )
            })
            .map_err(|e| format!("spawn preview-vt thread failed: {e}"))?;
        sessions.insert(
            stream_id.to_string(),
            Session {
                tx: cmd_tx,
                shutdown,
                done_rx,
                join: Some(join),
            },
        );
        match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(info)) => Ok(info),
            Ok(Err(e)) => {
                // The thread has already exited; keep the map clean.
                sessions.remove(stream_id);
                Err(e)
            }
            Err(_) => {
                sessions.remove(stream_id);
                Err("preview-vt open timed out".into())
            }
        }
    }

    pub fn request_frame_at(&self, stream_id: &str, target_us: i64) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let s = sessions
            .get(stream_id)
            .ok_or_else(|| format!("unknown preview-vt session '{stream_id}'"))?;
        s.tx.send(Msg::Request { target_us })
            .map_err(|_| format!("preview-vt session '{stream_id}' is closed"))
    }

    pub fn consume_ack(&self, stream_id: &str, slot: u32, gen: u32) -> Result<(), String> {
        let sessions = self.sessions.lock_recover();
        let s = sessions
            .get(stream_id)
            .ok_or_else(|| format!("unknown preview-vt session '{stream_id}'"))?;
        s.tx.send(Msg::Ack { slot, gen })
            .map_err(|_| format!("preview-vt session '{stream_id}' is closed"))
    }

    pub fn close(&self, stream_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock_recover();
        let Some(mut s) = sessions.remove(stream_id) else {
            return Ok(());
        };
        s.shutdown.store(true, Ordering::Release);
        let _ = s.tx.send(Msg::Close);
        if let Some(join) = s.join.take() {
            match s.done_rx.recv_timeout(CLOSE_GRACE) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                    let _ = join.join();
                }
                Err(RecvTimeoutError::Timeout) => {
                    // The thread is wedged in a codec call; detach. Its shutdown
                    // flag makes it clean up at the next frame boundary.
                }
            }
        }
        Ok(())
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.sessions.lock_recover().keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_emits_a_slot_and_frame_and_releases_on_ack() {
        let registry = PreviewVtRegistry::new();
        let (tx, rx) = mpsc::channel::<VtPoke>();
        registry.set_poke_sink(Box::new(move |poke| {
            let _ = tx.send(poke);
        }));
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_h264.mp4");
        let info = registry.open("session-test", path).expect("open");
        assert!(info.width > 0 && info.height > 0);
        registry
            .request_frame_at("session-test", 0)
            .expect("request");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut saw_slot = false;
        let mut ack = None;
        let mut error = None;
        while Instant::now() < deadline && (ack.is_none() || !saw_slot) {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(VtPoke::Slot {
                    width,
                    height,
                    pixel_format,
                    ..
                }) => {
                    assert!(width > 0 && height > 0);
                    assert!(pixel_format == "nv12" || pixel_format == "p010le");
                    saw_slot = true;
                }
                Ok(VtPoke::FrameReady { slot, gen, .. }) => {
                    ack = Some((slot, gen));
                }
                Ok(VtPoke::Error { message, .. }) => error = Some(message),
                Ok(VtPoke::Eof { .. }) => {}
                Err(_) => {}
            }
        }
        assert_eq!(error, None);
        assert!(saw_slot, "no IOSurface slot announced");
        let (slot, gen) = ack.expect("no frame delivered");
        registry
            .consume_ack("session-test", slot, gen)
            .expect("ack");
        registry.close("session-test").expect("close");
    }
}
