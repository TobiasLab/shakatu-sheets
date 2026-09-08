import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SessionOverlay } from "./components/SessionOverlay/SessionOverlay";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        {isTauri() && getCurrentWindow().label === "session-overlay" ? <SessionOverlay /> : <App />}
    </React.StrictMode>,
);
