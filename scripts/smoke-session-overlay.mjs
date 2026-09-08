// Run with Chromium listening on port 9222: node scripts/smoke-session-overlay.mjs
// Tests the real React components with synthetic session data and mocked native window events.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const harness = `import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { useSessionOverlay } from "./hooks/useSessionOverlay";
import { SessionOverlay } from "./components/SessionOverlay/SessionOverlay";
import { createSession, createEntry } from "./domain/session";
import "./index.css";

function Harness() {
    const [snapshot, setSnapshot] = useState({
        session: { ...createSession(), status: "running", elapsedMs: 3600000, startedAt: Date.now() },
        theme: "dark",
    });
    const overlay = useSessionOverlay(snapshot);
    window.updateSession = (count, status = "running") => setSnapshot(previous => ({
        ...previous,
        session: {
            ...previous.session,
            status,
            startedAt: status === "running" ? Date.now() : null,
            entries: Array.from({ length: count }, (_, i) => createEntry("Item " + i, i + 1, 100000, "vendor")),
        },
    }));
    window.updateTheme = theme => setSnapshot(previous => ({ ...previous, theme }));
    window.openOverlay = overlay.openOverlay;
    return <><p id="publisher-error">{overlay.error}</p><SessionOverlay /></>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><Harness /></React.StrictMode>);
`;

function installTauriMock() {
    window.isTauri = true;
    window.__shown = false;
    window.__calls = [];
    window.__formats = 0;
    const NativeFormat = Intl.NumberFormat;
    Intl.NumberFormat = function CountingNumberFormat(...args) {
        const formatter = new NativeFormat(...args);
        const format = formatter.format;
        Object.defineProperty(formatter, "format", {
            value: (...values) => {
                window.__formats++;
                return format(...values);
            },
        });
        return formatter;
    };
    const callbacks = new Map();
    const listeners = new Map();
    let next = 0;
    window.__event = (event, payload) => {
        for (const [id, args] of listeners) {
            if (args.event === event) callbacks.get(args.handler)?.({ event, id, payload: structuredClone(payload) });
        }
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(_event, id) {
            listeners.delete(id);
        },
    };
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "session-overlay" }, currentWebview: { label: "session-overlay" } },
        transformCallback(fn) {
            callbacks.set(++next, fn);
            return next;
        },
        unregisterCallback(id) {
            callbacks.delete(id);
        },
        async invoke(command, args = {}) {
            window.__calls.push({ command, args });
            switch (command) {
                case "plugin:window|get_all_windows":
                    return ["main", "session-overlay"];
                case "plugin:window|is_visible":
                    return window.__shown;
                case "plugin:window|is_minimized":
                    return false;
                case "plugin:window|show":
                    if (window.__failShow) throw Error("Synthetic show failure");
                    window.__shown = true;
                    return;
                case "plugin:window|hide":
                    window.__shown = false;
                    return;
                case "plugin:window|set_focus":
                case "plugin:window|start_dragging":
                    return;
                case "plugin:event|listen":
                    listeners.set(args.handler, args);
                    return args.handler;
                case "plugin:event|unlisten":
                    listeners.delete(args.eventId);
                    return;
                case "plugin:event|emit":
                case "plugin:event|emit_to":
                    // A delayed first snapshot exposes assumptions about the empty overlay being ready.
                    if (args.event === "session-overlay-state" && !window.__receivedSnapshot) {
                        await new Promise((resolve) => setTimeout(resolve, 150));
                        window.__receivedSnapshot = true;
                    }
                    window.__event(args.event, args.payload);
                    return;
                default:
                    throw Error(`Unexpected ${command}`);
            }
        },
    };
}

const page = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
});
const browserErrors = [];
let id = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === "Runtime.exceptionThrown") browserErrors.push(m.params);
    if (m.id) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(m.error) : p.resolve(m.result);
    }
});
const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(expression) {
    for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await sleep(50);
    }
    throw Error(`Timeout: ${expression} ${await evaluate("document.body.innerText")}`);
}
const server = await createServer({
    configFile: false,
    root: process.env.SESSION_PERF_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
    plugins: [
        {
            name: "overlay-smoke",
            enforce: "pre",
            transform(_code, id) {
                if (id.endsWith("/src/main.tsx")) return harness;
            },
        },
        react(),
    ],
    server: { host: "127.0.0.1", port: 0 },
});
try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installTauriMock.toString()})();` });
    await server.listen();
    await send("Page.navigate", { url: server.resolvedUrls.local[0] });
    await send("Page.bringToFront");
    await until('typeof window.updateSession === "function"');
    await sleep(200);
    const sends = () =>
        evaluate(
            'window.__calls.filter(c=>c.args.event === "session-overlay-state" && c.command === "plugin:event|emit_to").length',
        );
    for (const count of [0, 30, 300]) {
        await evaluate(`window.__calls=[];window.updateSession(${count})`);
        await sleep(100);
        const hiddenMessages = await sends();
        if (!process.env.BASELINE) assert.equal(hiddenMessages, 0);
        await evaluate("window.openOverlay()");
        await until(`document.querySelector('time') && document.querySelectorAll('li').length === ${count}`);
        await evaluate("window.__formats=0;window.__calls=[]");
        const start = await evaluate('document.querySelector("time").textContent');
        await sleep(2200);
        const formattingCalls = await evaluate("window.__formats");
        assert.notEqual(await evaluate('document.querySelector("time").textContent'), start);
        if (!process.env.BASELINE) assert(formattingCalls <= 6, "Timer ticks must not reformat item icons");
        const timerMessages = await sends();
        assert.equal(timerMessages, 0, "Timer ticks must not publish session snapshots");
        console.info(JSON.stringify({ count, hiddenMessages, formattingCalls, timerMessages }));
        await evaluate('document.querySelector("[aria-label=\\"Hide session overlay\\"]").click()');
        await sleep(100);
        if (!process.env.BASELINE) {
            const stopped = await evaluate('document.querySelector("time").textContent');
            await sleep(1100);
            assert.equal(await evaluate('document.querySelector("time").textContent'), stopped);
        }
    }
    if (!process.env.BASELINE) {
        await evaluate('window.updateTheme("light");window.updateSession(2,"paused")');
        await sleep(100);
        await evaluate("window.openOverlay()");
        await until(
            'document.documentElement.dataset.theme === "light" && document.querySelectorAll("li").length === 2 && document.body.innerText.includes("Paused")',
        );
        await evaluate('window.updateSession(1,"finished")');
        await until('document.querySelectorAll("li").length === 1 && document.body.innerText.includes("Finished")');
        await evaluate('window.updateSession(0,"idle")');
        await until('document.body.innerText.includes("No drops yet")');
        // Exercise the event emitted by the native close handler, then catch up on reopen.
        await evaluate('window.__shown=false;window.__event("session-overlay-visibility-changed")');
        await sleep(100);
        await evaluate("window.__calls=[];window.updateSession(30)");
        await sleep(100);
        assert.equal(await sends(), 0);
        await evaluate("window.openOverlay()");
        await until('document.querySelectorAll("li").length === 30');
        assert.equal(await evaluate('document.querySelector("#publisher-error").textContent'), "");
        await evaluate(
            'window.__shown=false;window.__event("session-overlay-visibility-changed");window.__failShow=true',
        );
        await sleep(100);
        await evaluate("window.openOverlay()");
        await until('document.querySelector("#publisher-error").textContent.includes("Synthetic show failure")');
        await evaluate("window.__failShow=false;window.openOverlay()");
        await until('document.querySelector("#publisher-error").textContent === ""');
        console.info("Overlay lifecycle smoke passed");
    }
    assert.deepEqual(browserErrors, []);
} finally {
    ws.close();
    await Promise.allSettled([fetch(`http://127.0.0.1:9222/json/close/${page.id}`), server.close()]);
}
