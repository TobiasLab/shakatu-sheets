import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SessionOverlay } from "./components/SessionOverlay/SessionOverlay";
import "@fontsource-variable/inter/wght.css";
import "./index.css";

// WebKitGTK can draw the focus ring when code moves focus after a click, for example when a dialog closes. The ring
// therefore follows the input device: a pointer press hides it until a key moves focus. Keys that only move the caret
// in a text field leave it hidden.
const focusKeys = new Set([
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
]);
let heldKey = "";
document.addEventListener(
    "pointerdown",
    () => {
        document.documentElement.dataset.input = "pointer";
    },
    true,
);
document.addEventListener(
    "keydown",
    (event) => {
        heldKey = event.key;
    },
    true,
);
document.addEventListener(
    "keyup",
    () => {
        heldKey = "";
    },
    true,
);
document.addEventListener(
    "focusin",
    () => {
        if (focusKeys.has(heldKey)) delete document.documentElement.dataset.input;
    },
    true,
);

const overlayWindow = isTauri() && getCurrentWindow().label === "session-overlay";
if (overlayWindow) document.documentElement.dataset.window = "session-overlay";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{overlayWindow ? <SessionOverlay /> : <App />}</React.StrictMode>,
);
