# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue or pull request for an unfixed vulnerability.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit. Reports are handled
on a best-effort basis by the maintainer, and you will be credited in the fix unless you prefer otherwise.

## Supported versions

Fixes are made on `main` and included in the next release. Older releases are not patched.

## Scope

Relevant reports include, for example:

- Exposure of the stored Garmoth API key or other local data.
- Ways for web content, network responses, or imported files to run commands or reach data outside their permissions.
- Bypasses of the content security policy or the per-window Tauri command permissions.
- Unexpected network traffic or data leaving the device.

Problems in Garmoth, Arsha, or Black Desert Online themselves should be reported to those services.
