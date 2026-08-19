# Dependency Management

Runtime dependencies are intentionally small:

- Tauri provides the desktop shell and IPC boundary.
- React renders the interface.
- `rusqlite` provides SQLite access and bundles SQLite for consistent Windows and Linux builds.
- Serde serializes Tauri command data.

Biome, TypeScript, Vite, and Vitest are development tools. Add a dependency only when existing platform APIs or current
dependencies cannot solve the requirement clearly. Commit both npm and Cargo lockfiles.
