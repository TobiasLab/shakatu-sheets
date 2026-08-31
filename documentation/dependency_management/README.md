# Dependency Management

Runtime dependencies are intentionally small:

- Tauri provides the desktop shell and IPC boundary.
- React renders the interface.
- `rusqlite` provides SQLite access and bundles SQLite for consistent Windows and Linux builds.
- Reqwest makes HTTPS requests to Arsha using Rustls rather than a platform TLS dependency.
- Serde serializes Tauri command data.
- `serde_json` parses Arsha responses and error messages.
- Tokio provides nonblocking delays between bounded retry attempts.
- `ashpd` performs the user-authorized XDG ScreenCast portal handshake on Linux.
- `pipewire` consumes the monitor stream returned by the Linux portal.

Biome, TypeScript, Vite, and Vitest are development tools. Add a dependency only when existing platform APIs or current
dependencies cannot solve the requirement clearly. Commit both npm and Cargo lockfiles.

The live-capture feasibility work temporarily pins Tauri to official commit
`382dd6ccc022277d5620fde90a39b4c5e896310e`, which contains the merged cross-platform WebView permission handler needed
for Linux display capture. Replace the Git pin with the first stable Tauri release that includes that API.

WebKitGTK 2.52 does not reliably complete the Linux ScreenCast portal lifecycle. Linux capture therefore uses `ashpd`
and PipeWire directly, while other platforms retain the WebView display-capture API. These dependencies are Linux-only
Cargo dependencies and do not affect Windows builds.
