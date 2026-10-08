# Miscellaneous

Current external-service research:

- [Arsha](https://api.arsha.io) provides cached regional Central Market data without an API key. Its upstream Pearl
  Abyss endpoints are unofficial and can fail intermittently. The application never polls Arsha and preserves existing
  snapshots when a manual refresh fails. One manual fetch may make up to three attempts when Arsha returns a server or
  network error.
- Garmoth has granted permission to use and publicly document its API endpoints and contracts in this open-source client.

## Garmoth Integration

The integration runs through the Rust/Tauri boundary. Each user supplies their own revocable Garmoth API key; Shakatu
Sheets does not operate a proxy or shared credential.

Implemented behavior:

1. Rust validates and stores each user's revocable API key locally, then sends it only in Garmoth's `apiKey` header.
2. Settings fetches validated character summaries from the approved character-build endpoint and persists the selected
   upload character. Garmoth requires users to provide the final ID segment from each character URL; the approved API
   does not expose an account-level character-list endpoint.
3. Grind-spot profiles retain the official spot IDs and exact drop keys, including enhancement sub-keys.
4. History shows a payload summary before an explicit upload. Rows outside the destination spot's export table are
   listed as omitted; local entries and full session totals are retained.
5. Uploads include integer minutes, net session and hourly income, all profile drop keys, and the selected character's
   class and specialization. Global-data sharing is opt-in and defaults off.
6. Durable per-session upload state guards retries; successful uploads can be repeated after explicit confirmation.
   Connect failures before transmission may be retried explicitly; timed-out, interrupted, or server-failed requests are
   marked unknown and never retried automatically because Garmoth provides no idempotency contract. After checking
   their Garmoth grind tracker, the user records whether the session arrived, which marks it uploaded or allows a new
   upload.

The endpoint documentation does not define character-build or upload success response bodies. The client validates the
documented character fields it consumes and treats any successful upload HTTP status as confirmation. Do not perform a
live upload during automated testing; use a disposable key and session for controlled integration checks.

Do not document credentials or captured user data in this repository.
