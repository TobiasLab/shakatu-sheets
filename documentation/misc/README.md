# Miscellaneous

Current external-service research:

- [Arsha](https://api.arsha.io) provides cached regional Central Market data without an API key. Its upstream Pearl
  Abyss endpoints are unofficial and can fail intermittently. The application never polls Arsha and preserves existing
  snapshots when a manual refresh fails. One manual fetch may make up to three attempts when Arsha returns a server or
  network error.
- Garmoth integration is intended for optional completed-session publishing, subject to official API documentation and
  permission for third-party clients.

Do not document credentials or captured user data in this repository.
