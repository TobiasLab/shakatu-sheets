# Miscellaneous

Current external-service research:

- [Arsha](https://api.arsha.io) provides cached regional Central Market data without an API key. Its upstream Pearl
  Abyss endpoints are unofficial and can fail intermittently. The application never polls Arsha and preserves existing
  snapshots when a manual refresh fails. One manual fetch may make up to three attempts when Arsha returns a server or
  network error.
- Garmoth has granted permission to use and publicly document its API endpoints and contracts in this open-source client.

## Next Milestone: Garmoth Integration

The next planned feature is direct Garmoth integration through the Rust/Tauri boundary. Each user will supply their own
revocable Garmoth API key; Shakatu Sheets will not operate a proxy or shared credential.

Implementation order:

1. Document the approved Garmoth endpoints, authentication, payloads, rate limits, and error responses.
2. Add a Rust API client using the existing HTTP stack and retrieve the official class, grind-spot, and drop metadata.
3. Map Shakatu grind spots and drops to stable Garmoth identifiers, including enhancement sub-keys. Complete: profiles
   now retain their persisted internal IDs alongside the official Garmoth spot IDs and exact drop keys.
4. Add local settings for the user's API key, character class, and specialization without exposing credentials to the
   frontend or logs.
5. Add an explicit payload preview and upload action for finished sessions. Uploads must never happen automatically.
6. Persist successful uploads per session to prevent duplicates. A timed-out upload must be marked unknown and never
   retried automatically because Garmoth may already have created it.
7. Cover request mapping and failure handling with mocked API tests, then perform one controlled live upload with a
   disposable user key.

Do not document credentials or captured user data in this repository.
