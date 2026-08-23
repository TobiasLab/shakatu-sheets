# Live Loot Recognition Plan

## Status

This document describes possible future work. Shakatu Sheets does not currently capture the game window or recognize
live loot notifications.

## Goal

Recognize BDO's in-game loot notifications while a session is running and add each new loot event to a reviewable feed.
The feature should remain local, explicit, and external to the game process. It must not inject into BDO, read process
memory, upload frames, or create video recordings.

Before implementing screen recognition, verify whether BDO exposes the same events through an allowed local log. A log
would be simpler and more reliable than visual recognition.

## Initial Scope

- English BDO client.
- 100% UI scale first; add 80% only after the 100% pipeline is measured and stable.
- A fixed loot-notification location selected by the user.
- User-triggered start and stop controls with a persistent capture indicator.
- Borderless-windowed mode as the recommended game display mode.
- Known grind-spot item names as the recognition dictionary.
- Local processing and persistence of recognized events only.

## Capture

Capture should use a live operating-system screen-sharing stream rather than repeatedly saving screenshots. The app
samples approximately 5-10 frames per second and copies only the configured notification rectangle into memory.

The quickest feasibility test is `navigator.mediaDevices.getDisplayMedia` inside the Tauri WebView. If WebView capture is
not reliable enough, use native platform capture behind the same start/stop interface:

- Windows Graphics Capture for a selected game window.
- `xdg-desktop-portal` ScreenCast with PipeWire on Wayland.
- The portal path on Linux where available instead of compositor-specific capture code.

Wayland intentionally requires an operating-system permission dialog. A supported portal may provide a restore token for
later sessions, but the application must never attempt to bypass capture consent.

The user selects the notification rectangle from a preview frame. Persist only normalized rectangle coordinates and any
platform restore token, never the preview or captured pixels.

## Recognition Pipeline

1. Crop each sampled frame to the configured notification region.
2. Detect notification rows and track their vertical movement between frames.
3. Wait until a new row's entrance animation settles before attempting OCR.
4. Align and combine several frames to suppress changing scenery, particles, and combat effects.
5. Resize the row to a canonical text height so later processing is independent of capture resolution.
6. Enhance local contrast and detect the notification's bright glyphs with dark outlines.
7. OCR both the enhanced grayscale row and an adaptively thresholded variant.
8. Fuzzy-match the recognized name against the active grind spot's known items.
9. Parse the rightmost `x <number>` quantity.
10. Accept the event only when recognition passes agree or confidence is high; otherwise send it to manual review.

The translucent notification background has already been composited with the game scene, so its original alpha channel
cannot be recovered. Preprocessing must use local contrast and multiple frames rather than one global brightness
threshold.

## Event Tracking

Recognition must run once per notification event, not once per frame. A visible row may persist across many frames, while
two identical rows may represent separate legitimate drops.

Track rows by position, motion, appearance time, text, and icon similarity. Assign each newly appearing row an event ID,
retain that ID while it moves through the stack, and count it once. Text-only deduplication is insufficient because two
consecutive drops can have the same item and quantity.

The review feed should show accepted and uncertain events in order. Users must be able to correct or remove an event
before finishing the session.

## Privacy And Safety

- Capture begins only after an explicit user action and operating-system consent.
- The interface always shows when capture is active and provides an immediate stop control.
- Full frames, cropped rows, and OCR images remain in memory and are discarded after processing.
- No screenshots or videos are persisted or uploaded by default.
- Optional diagnostic sample export must require a separate explicit action and show exactly what will be exported.
- Use operating-system capture APIs only; do not inject code, inspect game memory, or interfere with anti-cheat systems.
- Review BDO's current terms before shipping the feature.

## Rollout

1. Confirm Tauri capture behavior on Windows and Wayland without adding OCR.
2. Add rectangle selection and an in-memory preview at 100% UI scale.
3. Record local benchmark samples across bright, dark, crowded, and effect-heavy scenes with explicit consent.
4. Implement row detection and temporal event tracking.
5. Add constrained OCR and a known-item dictionary.
6. Add the editable event feed and session integration.
7. Measure accepted-event accuracy, missed events, and duplicate events on held-out samples.
8. Consider 80% UI scale only if normalization preserves acceptable results.

## Success Criteria

- At least 99% of automatically accepted events have the correct item and quantity.
- Uncertain events are withheld for review rather than silently guessed.
- A notification visible across multiple frames is counted once.
- Consecutive identical notifications are counted as separate events.
- Stopping capture releases the operating-system stream immediately.
- Normal use writes no captured pixels to disk and performs no recognition network requests.

Coverage is separate from accuracy: the system may leave difficult events for review to protect the accepted-event error
rate. Full-session accuracy also depends on avoiding missed frames and duplicate events, not only OCR quality.

## Open Questions

- Does BDO expose an allowed local loot log that removes the need for screen capture?
- Does `getDisplayMedia` work reliably in the current Tauri WebView on every target platform?
- How long do notifications remain visible at each UI scale and notification-stack setting?
- Can the notification region move independently through BDO's UI editor?
- Which item-name and quantity combinations are most likely to overlap combat text?
- What capture and recognition behavior is permitted by BDO's current terms?
