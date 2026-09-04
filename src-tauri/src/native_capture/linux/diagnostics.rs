use std::time::{Duration, Instant};

/// Aggregate only; no pixels, identifiers, or per-frame logs. Enabled explicitly for profiling.
pub(super) struct CaptureDiagnostics {
    started: Instant,
    source_frames: u64,
    samples: u64,
    bytes: usize,
    packing: Duration,
    sending: Duration,
    blocked: u64,
}

impl CaptureDiagnostics {
    pub(super) fn from_env() -> Option<Self> {
        (std::env::var_os("SHAKATU_CAPTURE_DIAGNOSTICS").as_deref()
            == Some(std::ffi::OsStr::new("1")))
        .then(Self::new)
    }

    fn new() -> Self {
        Self {
            started: Instant::now(),
            source_frames: 0,
            samples: 0,
            bytes: 0,
            packing: Duration::ZERO,
            sending: Duration::ZERO,
            blocked: 0,
        }
    }

    pub(super) fn source_frame(&mut self) {
        self.source_frames += 1;
        if self.started.elapsed() < Duration::from_secs(5) {
            return;
        }
        let seconds = self.started.elapsed().as_secs_f64();
        let samples = self.samples.max(1) as f64;
        eprintln!("capture metrics: source={:.1}fps sampled={:.1}fps ipc={:.2}MB/s pack={:.2}ms/sample send={:.2}ms/sample backpressure_skips={}",
            self.source_frames as f64 / seconds, self.samples as f64 / seconds,
            self.bytes as f64 / seconds / 1_000_000.0,
            self.packing.as_secs_f64() * 1000.0 / samples, self.sending.as_secs_f64() * 1000.0 / samples, self.blocked);
        *self = Self::new();
    }

    pub(super) fn blocked(&mut self) {
        self.blocked += 1;
    }

    pub(super) fn sample(&mut self, bytes: usize, packing: Duration, sending: Duration) {
        self.samples += 1;
        self.bytes += bytes;
        self.packing += packing;
        self.sending += sending;
    }
}
