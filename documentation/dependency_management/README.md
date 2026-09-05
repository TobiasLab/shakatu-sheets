# Dependency Management

Runtime dependencies are intentionally small:

- Tauri provides the desktop shell and IPC boundary.
- React renders the interface.
- `rusqlite` provides SQLite access and bundles SQLite for consistent Windows and Linux builds.
- Reqwest makes HTTPS requests to Arsha using Rustls rather than a platform TLS dependency.
- Serde serializes Tauri command data.
- `serde_json` parses Arsha responses and error messages.
- Tokio provides bounded retry delays and capture cancellation coordination.
- `ashpd` performs the user-authorized XDG ScreenCast portal handshake on Linux.
- `pipewire` consumes the monitor stream returned by the Linux portal.
- Windows-only `windows` 0.61.3 and `windows-future` 0.2.1 (MIT/Apache-2.0) bind the system WGC, D3D11, and WinRT APIs.
  These are maintained Microsoft Rust bindings already in Tauri's dependency family; direct feature selection adds native
  API bindings, not a separate capture runtime. `windows-future` enables the async picker adapter. Measure the resulting
  installer size on Windows before publishing; no Windows bundle size is established by Linux builds.

Biome, TypeScript, Vite, and Vitest are development tools. Add a dependency only when existing platform APIs or current
dependencies cannot solve the requirement clearly. Commit both npm and Cargo lockfiles.

WebKitGTK 2.52 does not reliably complete the Linux ScreenCast portal lifecycle. Linux capture therefore uses `ashpd`
and PipeWire directly. Windows uses WGC and GPU ROI copies; browser development retains Web display capture.
Platform dependencies are target-scoped. SQLite is bundled and Rustls/AWS-LC requires a native C toolchain; Windows
NASM/prebuilt-object setup is documented in [Windows development](../development/windows.md). No system OpenSSL is needed.
