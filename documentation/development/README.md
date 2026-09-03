# Development

Install dependencies and run the desktop application:

Linux builds require the PipeWire development headers (`libpipewire-0.3-dev` on Debian/Ubuntu or `pipewire-devel` on
Fedora) and Clang for the Rust PipeWire bindings' generated FFI.

The offline live-loot video benchmark additionally requires FFmpeg. Benchmark videos and generated frames must not be
committed. Development builds can write five-minute normal and rare ROI samples under the ignored
`dev-samples/live-loot/` directory.

```sh
npm install
npm run tauri dev
```

Run normal verification:

```sh
npm run check
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Build an AppImage on Arch-derived Linux distributions with:

```sh
npm run bundle:linux -- --bundles appimage
```

The application disables WebKitGTK's DMA-BUF renderer on Linux Wayland to avoid NVIDIA protocol errors. Live monitor
capture uses the XDG ScreenCast portal and PipeWire directly on Linux. Windows is not affected.
