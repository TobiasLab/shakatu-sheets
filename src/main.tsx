import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SessionOverlay } from "./components/SessionOverlay/SessionOverlay";
import "@fontsource-variable/inter/wght.css";
import "./index.css";

const overlayWindow = isTauri() && getCurrentWindow().label === "session-overlay";
if (overlayWindow) document.documentElement.dataset.window = "session-overlay";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{overlayWindow ? <SessionOverlay /> : <App />}</React.StrictMode>,
);
