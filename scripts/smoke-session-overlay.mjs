// Run with Chromium listening on port 9222: node scripts/smoke-session-overlay.mjs
// Tests the real React components with synthetic session data and mocked native window events.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const harness = `import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { useSessionOverlay } from "./hooks/useSessionOverlay";
import { usePersistedSession } from "./hooks/usePersistedSession";
import { useLootFont } from "./hooks/useLootFont";
import { useSelfImprovement } from "./hooks/useSelfImprovement";
import { useMarketPrices } from "./hooks/useMarketPrices";
import { getGrindSpot, getMarketItemIds } from "./data/grindSpots";
import { useOverlayOpacity } from "./hooks/useOverlayOpacity";
import { SettingsView } from "./views/Settings/Settings";
import { requestOverlayTimer } from "./api/sessionOverlay";
import { SessionOverlay } from "./components/SessionOverlay/SessionOverlay";
import { createEntry } from "./domain/session";
import "./index.css";

document.documentElement.dataset.window = "session-overlay";
function Harness() {
    const [theme, setTheme] = useState("dark");
    const [settingsVisible, setSettingsVisible] = useState(true);
    const opacity = useOverlayOpacity();
    const lootFont = useLootFont();
    const selfImprovement = useSelfImprovement();
    const persisted = usePersistedSession(opacity.flush);
    const spot = getGrindSpot(persisted.session.grindSpotId);
    const market = useMarketPrices(persisted.databaseLoaded, persisted.session.region, spot.id);
    const marketController = {
        session: persisted.session, spot, market, marketItemIds: getMarketItemIds(spot.id),
        databaseLoaded: persisted.databaseLoaded, editingDisabled: false, spotEditable: false,
        changeRegion: region => persisted.dispatch({ type: "set-region", region }), changeGrindSpot: () => {},
    };
    const overlay = useSessionOverlay({
        session: persisted.session, theme, opacity: opacity.opacity,
        timerEnabled: persisted.databaseLoaded && !persisted.closing,
    }, persisted.requestOverlayTimer);
    window.currentSession = persisted.session;
    window.overlayLootNames = [spot.trash, ...spot.drops].map(drop => drop.name);
    window.databaseLoaded = persisted.databaseLoaded;
    window.requestTimer = requestOverlayTimer;
    window.updateSession = (count, status = "running") => persisted.dispatch({
        type: "hydrate",
        session: {
            ...persisted.session,
            status,
            elapsedMs: 3600000,
            startedAt: status === "running" ? Date.now() : null,
            entries: Array.from({ length: count }, (_, i) => createEntry("Item " + i, i + 1, 100000, "vendor")),
        },
    });
    window.updateTheme = setTheme;
    window.showSettings = setSettingsVisible;
    window.openOverlay = overlay.openOverlay;
    return <><p id="publisher-error">{overlay.error}</p>
        {settingsVisible && <SettingsView selfImprovement={selfImprovement} marketController={marketController} lootFont={lootFont} theme={theme} onThemeChange={setTheme} onOpenCapture={() => {}} overlayOpacity={opacity} />}
        <SessionOverlay /></>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<React.StrictMode><Harness /></React.StrictMode>);
`;

function installTauriMock() {
    window.isTauri = true;
    window.__shown = false;
    window.__calls = [];
    window.__formats = 0;
    window.__itemFormats = 0;
    window.__savedOpacity = 65;
    const NativeFormat = Intl.NumberFormat;
    Intl.NumberFormat = function CountingNumberFormat(...args) {
        const formatter = new NativeFormat(...args);
        const format = formatter.format;
        Object.defineProperty(formatter, "format", {
            value: (...values) => {
                window.__formats++;
                if (args[0] === "de-DE") window.__itemFormats++;
                return format(...values);
            },
        });
        return formatter;
    };
    const callbacks = new Map();
    const listeners = new Map();
    let next = 0;
    window.__event = (event, payload) => {
        if (window.__dropTimer && event === "session-overlay-timer-request") return;
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
                case "load_active_session":
                    return null;
                case "save_session":
                    window.__savedSession = structuredClone(args.session);
                    return;
                case "load_market_prices":
                case "load_consumable_presets":
                    return [];
                case "load_garmoth_settings":
                    return { apiKeyConfigured: false, characterIds: [], characters: [], selectedCharacterId: null };
                case "quantity_learning":
                    return { enabled: false, autoAllow: false, examples: [] };
                case "load_loot_font":
                    return window.__savedLootFont ?? "korean";
                case "save_loot_font":
                    if (window.__failLootFont) throw Error("Synthetic font save failure");
                    window.__savedLootFont = args.font;
                    return;
                case "session_overlay_uses_layer_shell":
                    return window.__layerShell ?? false;
                case "adjust_session_overlay":
                    if (window.__failPlacement) throw Error("Synthetic placement failure");
                    return;
                case "load_overlay_opacity":
                    return window.__savedOpacity;
                case "save_overlay_opacity":
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    if (window.__failOpacity) throw Error("Synthetic opacity save failure");
                    window.__savedOpacity = args.opacity;
                    return;
                case "plugin:window|destroy":
                    window.__destroyed = true;
                    return;
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
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__layerShell = ${Boolean(process.env.OVERLAY_LAYER_SHELL)}; (${installTauriMock.toString()})();`,
    });
    await server.listen();
    await send("Page.navigate", { url: server.resolvedUrls.local[0] });
    await send("Page.bringToFront");
    await until('window.databaseLoaded && document.querySelector("#overlay-opacity")?.value === "65"');
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
        await until(
            `document.querySelector('time') && document.querySelectorAll('main ul[aria-label] > li').length === ${count}`,
        );
        await evaluate("window.__formats=0;window.__itemFormats=0;window.__calls=[]");
        const start = await evaluate('document.querySelector("time").textContent');
        await sleep(2200);
        const formattingCalls = await evaluate("window.__formats");
        assert.notEqual(await evaluate('document.querySelector("time").textContent'), start);
        if (!process.env.BASELINE) {
            assert.equal(await evaluate("window.__itemFormats"), 0, "Timer ticks must not reformat item quantities");
        }
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
            `document.documentElement.dataset.theme === "light" && document.querySelectorAll("main ul[aria-label] > li").length === 2 && document.querySelector('main button[aria-label="Resume timer"]') !== null`,
        );
        await evaluate('window.updateSession(1,"finished")');
        await until(
            'document.querySelectorAll("main ul[aria-label] > li").length === 1 && !document.querySelector("main button[aria-label$=timer]")',
        );
        await evaluate('window.updateSession(0,"idle")');
        await until('document.body.innerText.includes("No drops yet")');
        // Exercise the event emitted by the native close handler, then catch up on reopen.
        await evaluate('window.__shown=false;window.__event("session-overlay-visibility-changed")');
        await sleep(100);
        await evaluate("window.__calls=[];window.updateSession(30)");
        await sleep(100);
        assert.equal(await sends(), 0);
        await evaluate("window.openOverlay()");
        await until('document.querySelectorAll("main ul[aria-label] > li").length === 30');
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
        await evaluate("window.__calls=[];window.openOverlay()");
        await sleep(100);
        const focused = await evaluate('window.__calls.some(c => c.command === "plugin:window|set_focus")');
        assert.equal(focused, !process.env.OVERLAY_LAYER_SHELL, "Layer overlays must not request focus on opening");
        // Resize with large/negative earnings and a scrolling loot list: values must retain their unit and position.
        await evaluate('window.showSettings(false);document.querySelector("#publisher-error").style.display="none"');
        await until('!document.querySelector("#overlay-opacity")');
        for (const width of [480, 380, 360, 320]) {
            await send("Emulation.setDeviceMetricsOverride", {
                width,
                height: 180,
                deviceScaleFactor: 1,
                mobile: false,
            });
            let previousRight = null;
            for (const [amount, expected] of [
                [300990000, "300.99M"],
                [999999999, "999.99M"],
                [-300990000, "-300.99M"],
                [9007199254740991, "9007.19T"],
            ]) {
                for (const theme of ["dark", "light", "moss"]) {
                    await evaluate(`window.__event("session-overlay-state", {
                        session: {...window.currentSession, status:"paused", elapsedMs:3600000, startedAt:null,
                            entries:Array.from({length:30},(_,i)=>({id:String(i),name:window.overlayLootNames[i] ?? "Loot "+i,quantity:1,
                                unitPrice:i===0?Math.abs(${amount}):0,valuation:${amount}<0?"expense":"vendor",
                                saleMultiplier:1,source:"manual",createdAt:1})).map((entry,i)=>i?{...entry,valuation:"vendor"}:entry)},
                        theme:"${theme}",timerEnabled:true,opacity:100
                    })`);
                    await until(
                        `[...document.querySelectorAll('[aria-label="Session earnings"] strong:first-of-type [aria-hidden]')].find(el=>getComputedStyle(el).display!=="none")?.textContent.trim() === '${expected}'`,
                    );
                    const geometry = await evaluate(`(() => {
                        const main=document.querySelector('main').getBoundingClientRect();
                        const header=document.querySelector('main header').getBoundingClientRect();
                        const loot=document.querySelector('[aria-label="Dropped items"]');
                        const stats=[...document.querySelectorAll('[aria-label="Session earnings"] strong')];
                        return {headerHeight:header.height, lootTop:loot.getBoundingClientRect().top-main.top,
                            lootHeight:loot.clientHeight, scrolls:loot.scrollHeight>loot.clientHeight,
                            right:stats.map(el=>el.getBoundingClientRect().right),
                            fits:stats.every(el=>{
                                const value=[...el.querySelectorAll('[aria-hidden]')].find(s=>getComputedStyle(s).display!=='none');
                                const r=value.getBoundingClientRect(), label=el.previousElementSibling.getBoundingClientRect();
                                return r.left>=label.right+3 && r.right<=main.right-8 && r.height<=21;
                            }),
                            controls:[...document.querySelectorAll('main header button,main time')].every(el=>{
                                const r=el.getBoundingClientRect();return r.left>=main.left && r.right<=main.right && r.top>=main.top && r.bottom<=main.top+34;
                            })};
                    })()`);
                    assert(
                        geometry.fits && geometry.controls,
                        `Stats and controls fit at ${width}px: ${JSON.stringify(geometry)}`,
                    );
                    assert(geometry.headerHeight <= 28 && geometry.lootTop <= 68 && geometry.lootHeight >= 100);
                    assert(geometry.scrolls, "Loot scrolls independently in a short window");
                    if (previousRight)
                        assert.deepEqual(geometry.right, previousRight, "Earnings stay anchored as values change");
                    previousRight = geometry.right;
                    if (process.env.UI_SMOKE_OUTPUT && amount === 300990000 && [320, 480].includes(width)) {
                        await mkdir(process.env.UI_SMOKE_OUTPUT, { recursive: true });
                        const { data } = await send("Page.captureScreenshot", { format: "png" });
                        await writeFile(
                            `${process.env.UI_SMOKE_OUTPUT}/overlay-${width}-${theme}.png`,
                            Buffer.from(data, "base64"),
                        );
                    }
                }
            }
        }
        console.info("Overlay resize, precision, anchored metrics, and loot space passed in all themes");
        await evaluate("window.showSettings(true)");
        await until('!!document.querySelector("#overlay-opacity")');
        await evaluate(
            'window.__event("session-overlay-state",{session:window.currentSession,theme:"light",timerEnabled:true,opacity:65})',
        );
        await until(`!!document.querySelector('[aria-label="Pause timer"]')`);
        if (process.env.OVERLAY_LAYER_SHELL) {
            await evaluate("window.showSettings(false)");
            await sleep(100);
            await until(`document.querySelector('[aria-label="Resize overlay"]') !== null`);
            await evaluate(`document.querySelector('main header button').scrollIntoView({block: "center"})`);
            await sleep(100);
            const rect = await evaluate(
                `(() => { const r = document.querySelector('main header button').getBoundingClientRect(); return {x: r.x + 15, y: r.y + 10}; })()`,
            );
            await evaluate("window.__calls=[]");
            await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...rect,
                button: "left",
                buttons: 1,
                clickCount: 1,
            });
            await until('document.querySelector("main [role=status]")?.textContent.includes("Release to move")');
            await send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "ArrowRight",
                code: "ArrowRight",
                windowsVirtualKeyCode: 39,
            });
            await send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "ArrowRight",
                code: "ArrowRight",
                windowsVirtualKeyCode: 39,
            });
            await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: rect.x + 80,
                y: rect.y + 40,
                button: "left",
                buttons: 1,
            });
            assert.equal(
                await evaluate('window.__calls.filter(c => c.command === "adjust_session_overlay").length'),
                0,
                "Dragging and arrow keys must leave placement unchanged until release",
            );
            await send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: rect.x + 80,
                y: rect.y + 40,
                button: "left",
                buttons: 0,
                clickCount: 1,
            });
            await until('window.__calls.some(c => c.command === "adjust_session_overlay")');
            assert.deepEqual(await evaluate('window.__calls.find(c => c.command === "adjust_session_overlay").args'), {
                action: "move",
                dx: 80,
                dy: 40,
            });
            await evaluate("window.__calls=[]");
            await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...rect,
                button: "left",
                buttons: 1,
                clickCount: 1,
            });
            await until('document.querySelector("main [role=status]")?.textContent.includes("Release to move")');
            await evaluate(
                `document.querySelector('main header button').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));`,
            );
            await send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x: rect.x + 80,
                y: rect.y + 40,
                button: "left",
                buttons: 0,
                clickCount: 1,
            });
            assert.equal(
                await evaluate('window.__calls.filter(c => c.command === "adjust_session_overlay").length'),
                0,
                "Escape cancels placement",
            );
            await evaluate(
                `document.querySelector('[aria-label="Resize overlay"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));`,
            );
            await until(
                'window.__calls.some(c => c.command === "adjust_session_overlay" && c.args.action === "resize" && c.args.dx === 16)',
            );
            await evaluate(`document.querySelector('[aria-label="Move overlay to next display"]').click()`);
            await until(
                'window.__calls.some(c => c.command === "adjust_session_overlay" && c.args.action === "nextMonitor")',
            );
            await evaluate(
                `window.__failPlacement=true;document.querySelector('[aria-label="Move overlay to next display"]').click()`,
            );
            await until(
                'document.querySelector("main [role=alert]")?.textContent.includes("Synthetic placement failure")',
            );
            await evaluate("window.__failPlacement=false");
            await evaluate("window.showSettings(true)");
            await until('document.querySelector("#overlay-opacity")?.value === "65"');
            console.info("Wayland placement controls smoke passed");
        }

        assert.equal(await evaluate('document.querySelector("main input[type=range]")'), null);
        assert.equal(await evaluate('document.querySelector("main").style.opacity'), "0.65");
        assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgba(0, 0, 0, 0)");
        async function setOpacity(value) {
            await evaluate(`(() => {
                const input = document.querySelector('#overlay-opacity');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
        }
        await setOpacity(25);
        await until('document.querySelector("main").style.opacity === "0.25"');
        await setOpacity(80);
        await setOpacity(55);
        await evaluate("window.showSettings(false)");
        await until("window.__savedOpacity === 55");
        await evaluate("window.showSettings(true)");
        await until('document.querySelector("#overlay-opacity")?.value === "55"');
        await evaluate("window.__failOpacity=true");
        await setOpacity(70);
        await until('document.body.innerText.includes("Synthetic opacity save failure")');
        await evaluate(
            `window.__failOpacity=false; [...document.querySelectorAll('button')].find(b=>b.textContent==='Retry save').click()`,
        );
        await until(
            'window.__savedOpacity === 70 && !document.body.innerText.includes("Synthetic opacity save failure")',
        );
        console.info("Settings opacity preview, ordered saves, and retry passed");

        async function clickTimer(label) {
            await evaluate(
                `[...document.querySelectorAll('main button')].find(b=>b.getAttribute('aria-label')==='${label}').click()`,
            );
        }
        await send("Emulation.setDeviceMetricsOverride", {
            width: 320,
            height: 250,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await evaluate("window.__dropTimer=true");
        await clickTimer("Pause timer");
        await until('document.body.innerText.includes("did not respond")');
        assert(
            await evaluate(`(() => {
            const button = document.querySelector('[aria-label="Pause timer"]');
            return !button.disabled && button.getBoundingClientRect().right <= document.querySelector('main').getBoundingClientRect().right;
        })()`),
            "A timer error must leave the control enabled and inside the narrow overlay",
        );
        await evaluate("window.__dropTimer=false");
        await send("Emulation.setDeviceMetricsOverride", {
            width: 1000,
            height: 800,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await clickTimer("Pause timer");
        await until(
            'window.__savedSession.status === "paused" && !!document.querySelector(\'[aria-label="Resume timer"]:not(:disabled)\')',
        );
        const pausedTime = await evaluate('document.querySelector("time").textContent');
        await sleep(1200);
        assert.equal(await evaluate('document.querySelector("time").textContent'), pausedTime);
        await clickTimer("Resume timer");
        await until(
            'window.__savedSession.status === "running" && !!document.querySelector(\'[aria-label="Pause timer"]:not(:disabled)\')',
        );
        await sleep(1200);
        assert.notEqual(await evaluate('document.querySelector("time").textContent'), pausedTime);
        assert.match(
            await evaluate(`window.requestTimer('stale-session', 'pause').then(()=>'',String)`),
            /session has changed/,
        );
        assert.equal(await evaluate("window.currentSession.status"), "running");
        await evaluate('window.updateSession(0,"finished")');
        await until('!document.querySelector("main button[aria-label$=timer]")');
        assert.equal(
            await evaluate(`document.querySelectorAll('main button').length`),
            process.env.OVERLAY_LAYER_SHELL ? 4 : 2,
        );
        assert.match(
            await evaluate(`window.requestTimer(window.currentSession.id, 'resume').then(()=>'',String)`),
            /timer state has changed/,
        );
        await evaluate('window.updateSession(0,"idle")');
        await until("!!document.querySelector('[aria-label=\"Start timer\"]:not(:disabled)')");
        await clickTimer("Start timer");
        await until(
            'window.__savedSession.status === "running" && !!document.querySelector(\'[aria-label="Pause timer"]:not(:disabled)\')',
        );
        await setOpacity(85);
        await evaluate('window.__event("tauri://close-requested", {})');
        assert.match(
            await evaluate(`window.requestTimer(window.currentSession.id, 'pause').then(()=>'',String)`),
            /not available/,
        );
        await until("window.__destroyed");
        assert.equal(await evaluate("window.__savedOpacity"), 85);
        console.info("Overlay timer actions, stale requests, and save-before-close passed");
    }
    assert.deepEqual(browserErrors, []);
} finally {
    ws.close();
    await Promise.allSettled([fetch(`http://127.0.0.1:9222/json/close/${page.id}`), server.close()]);
}
