// Run against `npm run dev` and Chromium --remote-debugging-port=9222.
// No test pixels or credentials are persisted; all Tauri calls use synthetic fixtures.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = process.env.UI_SMOKE_OUTPUT ?? join(tmpdir(), "shakatu-ui");
const uiScale = Number(process.env.UI_SMOKE_SCALE ?? 80);
if (![80, 100].includes(uiScale)) throw new Error("Unsupported smoke UI scale");
const backend = process.env.UI_SMOKE_BACKEND === "windows" ? "windows" : "linux";
const source = process.env.UI_SMOKE_SOURCE ?? "3440x1440";
if (!["3440x1440", "2560x1440", "1920x1080"].includes(source)) throw new Error("Unsupported smoke source");
const [sourceWidth, sourceHeight] = source.split("x").map(Number);
const hasRecognitionProfile = source === "3440x1440" || source === "2560x1440";
const previewHeight = Math.round((sourceHeight * 640) / sourceWidth);
const appUrl = process.env.UI_SMOKE_URL ?? "http://127.0.0.1:1420";
const page = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
});
function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The workspace scrolls under the title bar, so horizontal overflow can hide inside it instead of the page.
const fitsWindow =
    "[document.documentElement, document.getElementById('workspace')].every((e) => e.scrollWidth <= e.clientWidth)";
async function until(expression, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(50);
    }
    throw new Error(
        `Timed out: ${expression}\n${JSON.stringify(await evaluate('({calls: window.__calls?.map(c=>({command:c.command,args:c.command.includes("preview")?c.args:null})), body:document.body?.innerText})'))}`,
    );
}
async function click(text) {
    const point = await evaluate(
        `(() => {
            const button = [...document.querySelectorAll('button,summary')].filter(b => !document.querySelector('dialog[open]') || document.querySelector('dialog[open]').contains(b)).find(b => (b.textContent.trim().replace(/\\s+/g, ' ') === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}) && b.getClientRects().length);
            if (!button || button.disabled) return null;
            button.scrollIntoView({block:'center'});
            const rect = button.getBoundingClientRect();
            return {x:rect.x + rect.width / 2,y:rect.y + rect.height / 2};
        })()`,
    );
    assert(point, `Missing or disabled control: ${text}`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await delay(150);
}
async function setField(selector, value) {
    await evaluate(`(() => {
        const field = document.querySelector(${JSON.stringify(selector)});
        if (!field) throw new Error('Missing field: ' + ${JSON.stringify(selector)});
        const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)});
        field.dispatchEvent(new Event('input', {bubbles:true}));
        field.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
}
async function setHistoryFilter(selector, value) {
    if (selector === "region") {
        await evaluate(
            `[...document.querySelectorAll('[aria-label="Recorded region"] button')].find(b => b.textContent === ${JSON.stringify(value.toUpperCase())}).click()`,
        );
        return;
    }
    await setField(selector, value);
}
async function clearHistoryFilters() {
    await click("Clear filters");
}
async function press(key, code, windowsVirtualKeyCode) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
}
await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    localStorage.clear();
    // Keep persisted-fixture assertions fast with main's one-minute autosave batching.
    // The persistence unit tests verify the real interval and batching behavior.
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => nativeSetInterval(callback, delay === 60000 ? 100 : delay, ...args);
    window.isTauri = true;
    const calls = window.__calls = [];
    const callbacks = new Map();
    let nextCallbackId = 0;
    const listeners = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { listeners.delete(id); } };
    window.__resize = () => { for (const [id, args] of listeners) if (args.event === "tauri://resize") callbacks.get(args.handler)?.({event: args.event, payload:{width:1280,height:820}, id}); };
    window.__minimized = false;
    window.__maximized = false;
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback(fn) { const id = ++nextCallbackId; callbacks.set(id, fn); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
            calls.push({ command, args });
            if (command === "plugin:window|get_all_windows") return [];
            if (command === "load_active_session") {
                if (new URLSearchParams(location.search).has("history-startup")) {
                    return new Promise(resolve => { window.__restoreHistorySession = resolve; });
                }
                return null;
            }
            if (command === "quantity_learning") {
                window.__selfImprovement ??= {enabled:false,autoAllow:false,examples:[],unreadable:[]};
                if (args.operation.kind === "settings") Object.assign(window.__selfImprovement, {enabled:args.operation.enabled,autoAllow:args.operation.enabled && args.operation.autoAllow});
                return structuredClone(window.__selfImprovement);
            }
            if (command === "load_loot_font") return window.__savedLootFont ?? "korean";
            if (command === "save_loot_font") {
                if (window.__failLootFont) throw Error("Synthetic font save failure");
                window.__savedLootFont = args.font;
                return;
            }
            if (command === "load_overlay_opacity") return 100;
            // StrictMode loads twice, so preference loads fail until the test makes them available again.
            const preferencesFail = new URLSearchParams(location.search).has("preference-load-failure") && !window.__preferencesAvailable;
            if (command === "load_theme") {
                if (preferencesFail) throw Error("Synthetic theme load failure");
                return window.__theme ?? null;
            }
            if (command === "save_theme") { window.__theme = args.theme; return; }
            if (command === "load_spot_preferences") {
                if (preferencesFail) throw Error("Synthetic favorites load failure");
                return window.__spotPreferences ?? null;
            }
            if (command === "save_spot_preferences") { window.__spotPreferences = args.preferences; return; }
            if (command === "save_overlay_opacity") return;
            if (command === "load_market_prices") return window.__marketPrices?.[args.region] ?? [];
            if (command === "fetch_market_prices") {
                await new Promise(resolve => setTimeout(resolve, 250));
                if (window.__failPrices) throw Error("Synthetic price failure");
                const prices = args.itemIds.map(itemId => ({itemId, region:args.region, basePrice:12345, fetchedAt:Date.now()}));
                (window.__marketPrices ??= {})[args.region] = prices;
                return prices;
            }
            if (command === "list_finished_sessions") {
                if (window.__failHistory) throw Error("Synthetic history read failure");
                const fixture = { session: {id:"fixture-finished",status:"finished",region:"eu",grindSpotId:"sycraia-lower-revamp",startedAt:null,elapsedMs:3600000,entries:[{id:"fixture-loot",name:"Ancient Spirit Dust",quantity:12,unitPrice:3000000,valuation:"vendor",saleMultiplier:1,source:"manual",createdAt:1788520000000}]},finishedAt:1788523600000,garmothUploadStatus:null };
                const source = window.__historyRecords ?? [fixture];
                const q = args.query;
                const scope = source.filter(r => r.session.status === "finished" && (q.region === null || r.session.region === q.region) && (q.finishedFromMs === null || r.finishedAt >= q.finishedFromMs) && (q.finishedBeforeMs === null || r.finishedAt < q.finishedBeforeMs));
                const groups = new Map();
                for (const r of scope) {
                    const key = r.session.grindSpotId;
                    const group = groups.get(key) ?? { grindSpotId:key, sessionCount:0, elapsedMs:0, net:0, timedNet:0, zeroDurationCount:0, lastFinishedAt:0 };
                    const net = r.session.entries.reduce((sum,e) => sum + e.quantity*e.unitPrice*(e.valuation === "expense" ? -1 : e.saleMultiplier),0);
                    group.sessionCount++; group.elapsedMs += r.session.elapsedMs; group.net += net; group.lastFinishedAt = Math.max(group.lastFinishedAt, r.finishedAt);
                    if (r.session.elapsedMs > 0) group.timedNet += net; else group.zeroDurationCount++;
                    groups.set(key,group);
                }
                const filtered = scope.filter(r => q.grindSpotId === null || r.session.grindSpotId === q.grindSpotId).sort((a,b) => b.finishedAt-a.finishedAt || a.session.id.localeCompare(b.session.id));
                const offset = Math.min(q.offset,Math.floor(Math.max(0,filtered.length-1)/q.limit)*q.limit);
                const result = {records:filtered.slice(offset,offset+q.limit), totalCount:filtered.length, offset, spotSummaries:[...groups.values()]};
                if (window.__holdHistory) {
                    window.__holdHistory = false;
                    await new Promise(resolve => { window.__releaseHistory = resolve; });
                }
                return result;
            }
            if (command === "load_session_trend") {
                if (window.__holdTrend === args.sessionId) {
                    window.__holdTrend = null;
                    await new Promise(resolve => { window.__releaseTrend = resolve; });
                }
                return window.__trendSamples?.[args.sessionId] ?? [];
            }
            if (command === "delete_finished_session") {
                window.__historyRecords = window.__historyRecords.filter(r => r.session.id !== args.id);
                if (window.__failHistoryAfterDelete) window.__failHistory = true;
                return;
            }
            if (command === "reopen_session") {
                const record = window.__historyRecords.find(r => r.session.id === args.id);
                if (record.garmothUploadStatus !== null) throw Error("Sessions sent to Garmoth cannot be reopened.");
                record.session.status = "paused";
                return record.session;
            }
            if (command === "native_capture_capabilities") return { backend: ${JSON.stringify(backend)}, available: true, reason: null, debugRoiSamples: true };
            if (command === "load_loot_capture_settings") return null;
            if (command === "load_garmoth_settings") {
                if (new URLSearchParams(location.search).has("supplemental-drops")) {
                    return { apiKeyConfigured: true, characterIds: [1], characters: [{id:1,name:"Fixture character"}], selectedCharacterId: 1, buffIds: [2, 8] };
                }
                if (window.__failSettings) throw Error("Synthetic settings read failure");
                return { apiKeyConfigured: window.__keyConfigured ?? false, characterIds: [], characters: [], selectedCharacterId: null };
            }
            if (command === "save_garmoth_api_key") { window.__keyConfigured = true; return; }
            if (command === "upload_garmoth_session") {
                const record = window.__historyRecords.find(r => r.session.id === args.input.sessionId);
                record.garmothUploadStatus = "success";
                return {status:"success",message:"Session uploaded to Garmoth.",savedSession:null};
            }
            if (command === "load_consumable_presets") {
                if (window.__holdPresets) await new Promise(resolve => { window.__releasePresets = resolve; });
                if (window.__failPresets) throw Error("Synthetic preset read failure");
                return window.__presets ?? [];
            }
            if (command === "save_consumable_presets") { window.__presets = args.presets; return; }
            if (command === "save_session") { window.__session = args.session; return; }
            if (command === "start_native_display_capture") {
                window.__capture = args.frames;
                const frame = new ArrayBuffer(40 + 640 * ${previewHeight} * 4);
                [3,1,1,1,640,${previewHeight},${sourceWidth},${sourceHeight},0,0].forEach((v,i)=>new DataView(frame).setUint32(i*4,v,true));
                let batch = 1;
                window.__emitFrame = () => { new DataView(frame).setUint32(12,batch++,true); args.frames.onmessage(frame.slice(0)); };
                window.__emitSearch = (selection, rare = false) => {
                    const data = new ArrayBuffer(40 + 800 * 600 * 4);
                    [3,4,1,batch++,800,600,${sourceWidth},${sourceHeight},Math.round(selection.region.x * ${sourceWidth}),Math.round(selection.region.y * ${sourceHeight})].forEach((v,i)=>new DataView(data).setUint32(i*4,v,true));
                    const pixels = new Uint8ClampedArray(data,40);
                    if (rare) {
                        const paint = (left,top,right,bottom) => { for(let y=top;y<bottom;y++) for(let x=left;x<right;x++) pixels.set([180,125,35,255],(y*800+x)*4); };
                        if (selection.uiScalePercent === 100) {
                            paint(281,244,663,300);
                            paint(350,243,600,248);
                        } else {
                            paint(265,235,570,280);
                            paint(320,234,520,238);
                        }
                    } else {
                        const factor = selection.uiScalePercent / 80;
                        const centers = selection.uiScalePercent === 100 ? [206,255] : [165,204];
                        for (const center of centers) for (let y=100+center-Math.round(6*factor);y<=100+center+Math.round(6*factor);y++) for(let x=219+Math.round(-19*factor);x<219+Math.round(249*factor);x++) pixels.set([220,220,220,255],(y*800+x)*4);
                    }
                    args.frames.onmessage(data);
                };
                window.__emitLoot = (rows) => {
                    const settings = calls.filter(c => c.command === "set_native_display_capture_region" && c.args.selection?.mode === "regions").at(-1).args.selection.settings;
                    const scale = settings.uiScalePercent / 80;
                    const width = settings.uiScalePercent === 100 ? 341 : 272;
                    const height = settings.uiScalePercent === 100 ? 226 : 180;
                    const data = new ArrayBuffer(40 + width * height * 4);
                    [3,2,1,batch++,width,height,${sourceWidth},${sourceHeight},Math.round(settings.region.x * ${sourceWidth}),Math.round(settings.region.y * ${sourceHeight})].forEach((v,i)=>new DataView(data).setUint32(i*4,v,true));
                    const pixels = new Uint8ClampedArray(data,40);
                    for (let row=0;row<rows;row++) {
                        const center = (settings.uiScalePercent === 100 ? 211 : 168) - row * (settings.uiScalePercent === 100 ? 49 : 39);
                        for (let x=Math.round(108*scale)-(settings.uiScalePercent === 100 ? 97 : 78);x<Math.round(250*scale)-(settings.uiScalePercent === 100 ? 97 : 78);x+=4) for (let y=center-5;y<=center+5;y++) pixels.set([230,230,230,255],(y*width+x)*4);
                    }
                    args.frames.onmessage(data);
                };
                setTimeout(window.__emitFrame,50);
                return;
            }
            if (command === "read_normal_loot_layout") {
                if (args.xml === '<wrong-scale/>') return {x:0.2,y:0.7,uiScalePercent:${uiScale === 80 ? 100 : 80}};
                if (args.xml !== '<layout-fixture/>') throw new Error('Invalid layout fixture');
                return {x:0.2,y:0.7,uiScalePercent:${uiScale}};
            }
            if (command === "plugin:window|is_minimized") return window.__minimized;
            if (command === "plugin:window|is_maximized") return window.__maximized;
            if (command === "plugin:event|listen") { const id = args.handler; listeners.set(id, args); return id; }
            if (command === "debug_roi_sample_collection_status") throw new Error("Debug collection unavailable in test");
            if (["acknowledge_native_display_frame", "set_native_display_capture_region", "set_native_display_capture_preview_enabled", "stop_native_display_capture", "save_loot_capture_settings", "plugin:event|unlisten", "plugin:window|minimize", "plugin:window|toggle_maximize", "plugin:window|close"].includes(command)) return;
            throw new Error("Unexpected test command: " + command);
        }
    };
`,
});
try {
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: appUrl });
    await until("document.querySelector('button.primary-button')?.disabled === false");
    if (process.env.UI_SCREENSHOT_ONLY !== "1") {
        assert(await evaluate("!document.querySelector('select[aria-label=Region]')"));
        assert(
            await evaluate(
                "!document.body.textContent.includes('Ready to grind') && !document.body.textContent.includes('Saved on this device')",
            ),
        );
    }
    await mkdir(output, { recursive: true });
    async function screenshot(name) {
        // Let theme transitions and dialog entry settle before recording pixels.
        await delay(180);
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(`${output}/${name}.png`, Buffer.from(data, "base64"));
    }
    await screenshot("desk-idle");
    if (process.env.UI_SCREENSHOT_ONLY !== "1") {
        await click("Browse all spots");
        assert.equal(await evaluate("document.activeElement?.type"), "search");
        const activeOutline = "getComputedStyle(document.activeElement).outlineStyle";
        assert.equal(await evaluate(activeOutline), "none", "Focus moved after a click draws no focus ring");
        await press("ArrowLeft", "ArrowLeft", 37);
        assert.equal(await evaluate(activeOutline), "none", "Caret keys keep the focus ring hidden");
        await press("ArrowDown", "ArrowDown", 40);
        assert.equal(await evaluate("document.activeElement.hasAttribute('data-spot-choose')"), true);
        assert.equal(await evaluate(activeOutline), "solid", "A key that moves focus brings the ring back");
        assert.equal(await evaluate("document.querySelectorAll('dialog[open] li').length"), 97);
        await click("Favorites");
        assert(await evaluate("document.querySelector('dialog[open]').textContent.includes('No favorites yet')"));
        assert.equal(await evaluate(activeOutline), "none");
        await press("Tab", "Tab", 9);
        assert.equal(await evaluate(activeOutline), "solid", "Tab brings the focus ring back after a click");
        await click("All");
        await setField('dialog[open] input[type="search"]', "END STAR’S");
        await until("document.querySelectorAll('dialog[open] li').length === 1");
        await click("Star Star's End");
        assert(await evaluate("document.querySelector('dialog[open]') !== null"), "Starring keeps browser open");
        assert.equal(await evaluate("window.__session.grindSpotId"), "sycraia-lower-revamp");
        await click("Star's End");
        await until("!document.querySelector('dialog[open]')");
        assert.equal(await evaluate("document.activeElement?.textContent"), "Browse all spots");
        await until("window.__session.grindSpotId === 'stars-end-revamp'");
        assert.equal(await evaluate("window.__session.status"), "idle");
        await click("Browse all spots");
        assert.equal(await evaluate("document.querySelector('dialog[open] input').value"), "");
        await setField('dialog[open] input[type="search"]', "no matching spot");
        assert(await evaluate("document.querySelector('dialog[open]').textContent.includes('No spots match')"));
        await click("Clear search");
        for (const theme of ["dark", "light"]) {
            await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
            await screenshot(`spot-browser-${theme}`);
        }
        await send("Emulation.setDeviceMetricsOverride", {
            width: 640,
            height: 720,
            deviceScaleFactor: 1,
            mobile: false,
        });
        assert(
            await evaluate(
                "document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth",
            ),
        );
        await screenshot("spot-browser-compact");
        for (let i = 0; i < 8; i++) {
            await press("Tab", "Tab", 9);
            assert(await evaluate("document.activeElement.closest('dialog')?.open"), "Tab stays in browser");
        }
        await press("Escape", "Escape", 27);
        assert.equal(await evaluate("document.activeElement?.textContent"), "Browse all spots");
        await send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 820,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await evaluate("document.documentElement.dataset.theme = 'dark'");
        await click("Browse all spots");
        await setField('dialog[open] input[type="search"]', "sycraia lower");
        await evaluate("document.querySelector('dialog[open] li > button').click()");
        await until("window.__session.grindSpotId === 'sycraia-lower-revamp'");
        await screenshot("spot-shortcuts");
        await click("Settings");
        await click("Browse all spots");
        assert.equal(await evaluate("document.activeElement?.type"), "search");
        await setField('dialog[open] input[type="search"]', "star's end");
        await click("Star's End");
        await until("window.__session.grindSpotId === 'stars-end-revamp'");
        assert(await evaluate("document.querySelector('#market h3').textContent.includes('End')"));
        assert(await evaluate("document.activeElement.closest('#market') !== null"));
        await click("Browse all spots");
        await press("Escape", "Escape", 27);
        assert(await evaluate("document.activeElement.closest('#market') !== null"));
        await click("Grind desk");
        assert(await evaluate("document.querySelector('[aria-label=\"Grind spot\"] h2').textContent.includes('End')"));
        await click("Settings");
        await click("Browse all spots");
        await setField('dialog[open] input[type="search"]', "sycraia lower");
        await evaluate("document.querySelector('dialog[open] li > button').click()");
        await until("window.__session.grindSpotId === 'sycraia-lower-revamp'");
        await screenshot("settings-spot-browser");
        await click("Grind desk");
        assert(
            await evaluate(
                "document.querySelector('nav[aria-label=\"Application views\"]').getBoundingClientRect().bottom <= 48",
            ),
            "Navigation must stay in the top bar",
        );
        for (const [label, command] of [
            ["Minimize window", "plugin:window|minimize"],
            ["Maximize window", "plugin:window|toggle_maximize"],
            ["Close window", "plugin:window|close"],
        ]) {
            await click(label);
            assert(
                await evaluate(`window.__calls.some((call) => call.command === ${JSON.stringify(command)})`),
                `${label} requests ${command}`,
            );
            assert.notEqual(
                await evaluate("document.activeElement?.getAttribute('aria-label')"),
                label,
                "Window buttons leave focus where it was",
            );
        }
        await evaluate("window.__maximized = true; window.__resize()");
        await until(`document.querySelector('[aria-label="Restore window"]') !== null`);
        await evaluate("window.__maximized = false; window.__resize()");
        await until(`document.querySelector('[aria-label="Maximize window"]') !== null`);
    }
    if (process.env.UI_SCREENSHOT_ONLY === "1") {
        console.log(`Screenshot saved: ${output}/desk-idle.png`);
    } else {
        // Shared controls retain native labels and recover from loading and failed tasks.
        await evaluate("window.__failSettings = true");
        await click("Settings");
        await until("document.body.textContent.includes('Synthetic settings read failure')");
        assert(
            await evaluate(
                "document.querySelector('input[name=apiKey]').closest('form').querySelector('[role=alert]') !== null",
            ),
        );
        assert(
            await evaluate("document.body.textContent.includes('Unavailable')"),
            "A failed settings load must not claim the key is not configured",
        );
        await evaluate("window.__failSettings = false");
        await click("Retry settings");
        await until("!document.querySelector('input[name=apiKey]').disabled");
        await setField('input[name="apiKey"]', "synthetic-ui-test-key");
        await click("Validate and save key");
        await until(
            "document.querySelector('input[name=apiKey]').closest('form').textContent.includes('API key validated')",
        );
        assert.equal(await evaluate("document.querySelector('input[name=apiKey]').value"), "");
        assert(
            await evaluate("document.querySelector('input[name=apiKey]').labels[0].textContent.includes('API key')"),
        );
        await screenshot("settings-key-feedback");
        await evaluate("window.__keyConfigured = false");
        await click("Grind desk");
        await evaluate("window.__holdPresets = true; window.__failPresets = true");
        await click("Apply preset");
        await until("document.querySelector('dialog[open]').textContent.includes('Loading presets')");
        assert(!(await evaluate("document.querySelector('dialog[open]').textContent.includes('No EU presets')")));
        await evaluate("window.__holdPresets = false; window.__releasePresets()");
        await until("document.querySelector('dialog[open]').textContent.includes('Synthetic preset read failure')");
        await screenshot("preset-load-error");
        await evaluate("window.__failPresets = false");
        await click("Retry");
        await until("document.querySelector('dialog[open]').textContent.includes('No EU presets')");
        await click("Close consumable presets");
        await click("History");
        await evaluate("window.__historyRecords = []");
        await click("Reload");
        await until("document.body.textContent.includes('No completed sessions yet')");
        await screenshot("history-empty");
        await setField('input[type="date"]', "2026-10-01");
        await setField("#history-completed-through", "2026-09-01");
        await until("document.querySelectorAll('[aria-label=\"Filters\"] [aria-invalid=true]').length === 2");
        assert(
            await evaluate(
                "document.querySelector('[aria-label=\"Filters\"] [aria-invalid=true]').getAttribute('aria-describedby') === 'history-date-error'",
            ),
        );
        await until("document.getElementById('history-date-error') !== null");
        await screenshot("history-date-error");
        await clearHistoryFilters();
        await evaluate("window.__failHistory = true");
        await click("Reload");
        await until("document.body.textContent.includes('Synthetic history read failure')");
        await evaluate("window.__failHistory = false; delete window.__historyRecords");
        await click("Retry history");
        await until("document.body.textContent.includes('1–1 of 1 sessions')");
        await click("Grind desk");
        await send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        await click("Import a screenshot");
        assert(
            await evaluate(`document.querySelector('dialog[open]').getAnimations().length === 0 &&
                getComputedStyle(document.querySelector('[aria-label="Close screenshot import"]'))
                    .transitionDuration.split(',').every(duration => parseFloat(duration) === 0)`),
            "Reduced motion must suppress dialog animation and control transitions",
        );
        await send("Emulation.setEmulatedMedia", { features: [] });
        await evaluate(`(() => {
            const input = document.querySelector('input[type=file]');
            const files = new DataTransfer();
            files.items.add(new File(['invalid image'], 'invalid.png', {type:'image/png'}));
            input.files = files.files;
            input.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await until("document.body.textContent.includes('Could not decode screenshot')");
        await evaluate("document.querySelector('[aria-label=\"Close screenshot import\"]').click()");
        await click("Start timer");
        await until("window.__session.status === 'running'");
        assert(
            await evaluate(`(() => {
                const spot = document.querySelector('[aria-label="Grind spot"]');
                return spot && [...spot.querySelectorAll('button')].every(button => button.getClientRects().length === 0) &&
                    spot.textContent.includes('Grind spot locked for this session');
            })()`),
            "The spot stays visible while selection controls disappear once time is recorded",
        );
        await click("Choose capture source");
        await until(
            "window.__calls.some(c => c.command === 'set_native_display_capture_preview_enabled' && c.args.enabled)",
        );
        if (process.env.UI_SMOKE_SOURCE) {
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'regions'",
            );
            assert.equal(
                await evaluate(
                    "window.__calls.some(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'search')",
                ),
                false,
                "Capture must start in manual mode",
            );
            for (const scale of [80, 100, uiScale]) {
                await evaluate(`(() => {
                    const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '80'));
                    select.value = '${scale}';
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                })()`);
                await until(
                    `[...document.querySelectorAll('button')].some(b => b.textContent === 'Adjust automatically') === true`,
                );
            }
            assert.equal(
                await evaluate(
                    "window.__calls.some(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'search')",
                ),
                false,
                "Changing UI scale must not start search",
            );
            const currentAreas =
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection.settings";
            for (const [area, field, other] of [
                ["Loot stack", "region", "rareRegion"],
                ["Rare loot", "rareRegion", "region"],
            ]) {
                await click(area);
                for (const [direction, dx, dy] of [
                    ["up", 0, -1],
                    ["left", -1, 0],
                    ["down", 0, 1],
                    ["right", 1, 0],
                ]) {
                    const before = await evaluate(currentAreas);
                    await click(`Move selected area ${direction} by 1 pixel`);
                    const after = await evaluate(currentAreas);
                    assert.equal(Math.round((after[field].x - before[field].x) * sourceWidth), dx);
                    assert.equal(Math.round((after[field].y - before[field].y) * sourceHeight), dy);
                    assert.deepEqual(after[other], before[other], "Nudging must preserve the other area");
                }
            }
            await click("Loot stack");
            await evaluate(
                "[...document.querySelectorAll('summary')].find(s => s.textContent === 'Import loot stack position from BDO').focus()",
            );
            await press(" ", "Space", 32);
            await until(
                "[...document.querySelectorAll('summary')].find(s => s.textContent === 'Import loot stack position from BDO').parentElement.open",
            );
            await press("Tab", "Tab", 9);
            await until("document.activeElement?.tagName === 'INPUT'");
            assert.equal(
                await evaluate("document.activeElement?.getAttribute('aria-label')"),
                "Import normal loot position from gamevariable.xml",
                "Opening import with the keyboard must make the file chooser the next tab stop",
            );
            const beforeImport = await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection.settings",
            );
            await evaluate(`(() => {
                const input = document.querySelector('input[aria-label="Import normal loot position from gamevariable.xml"]');
                const transfer = new DataTransfer();
                transfer.items.add(new File(['<layout-fixture/>'], 'gamevariable.xml', {type:'application/xml'}));
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', {bubbles:true}));
            })()`);
            await until("document.body.textContent.includes('Normal area moved to the saved layout position')");
            assert.equal(
                await evaluate("document.activeElement?.getAttribute('aria-label')"),
                "Import normal loot position from gamevariable.xml",
                "Reading a layout must preserve keyboard focus on the file chooser",
            );
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.settings?.region.x < 0.3",
            );
            const imported = await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection.settings",
            );
            assert.deepEqual(imported.rareRegion, beforeImport.rareRegion);
            assert.equal(
                Math.round(imported.region.x * sourceWidth),
                Math.round(0.2 * sourceWidth - (uiScale === 80 ? 136 : 170.5)) + (uiScale === 80 ? 25 : 31),
            );
            assert.equal(
                Math.round(imported.region.y * sourceHeight),
                Math.round(0.7 * sourceHeight - (uiScale === 80 ? 90 : 113)) + (uiScale === 80 ? 21 : 26),
            );
            assert.equal(imported.region.width, beforeImport.region.width);
            assert.equal(imported.region.height, beforeImport.region.height);
            assert(
                await evaluate(
                    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Confirm both areas' && !b.disabled)",
                ),
            );
            const guidePoint = await evaluate(`(() => {
                const envelope = document.querySelector('[data-loot-region="normal"]');
                if (getComputedStyle(envelope).outlineStyle !== 'none') throw new Error('Capture margin should be hidden');
                const guide = envelope.querySelector('[aria-hidden="true"]');
                guide.scrollIntoView({block:'center'});
                const box = guide.getBoundingClientRect();
                return {x:box.left + box.width * 0.2,y:box.top + box.height * 0.5};
            })()`);
            await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                button: "left",
                clickCount: 1,
                ...guidePoint,
            });
            await send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                button: "left",
                clickCount: 1,
                ...guidePoint,
            });
            await delay(150);
            assert.deepEqual(
                await evaluate(
                    "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection.settings.region",
                ),
                imported.region,
                "Grabbing off-center must not jump",
            );
            const stageWidth = await evaluate(
                "document.querySelector('[aria-label=\"Sampled capture preview\"]').getBoundingClientRect().width",
            );
            await send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                button: "left",
                clickCount: 1,
                ...guidePoint,
            });
            await send("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                button: "left",
                buttons: 1,
                x: guidePoint.x + 20,
                y: guidePoint.y,
            });
            await send("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                button: "left",
                clickCount: 1,
                x: guidePoint.x + 20,
                y: guidePoint.y,
            });
            await delay(150);
            const dragged = await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection.settings",
            );
            assert(
                Math.abs((dragged.region.x - imported.region.x) * sourceWidth - (20 * sourceWidth) / stageWidth) <= 1,
            );
            assert.deepEqual(dragged.rareRegion, imported.rareRegion);
            for (const [contents, message] of [
                ["<invalid/>", "Invalid layout fixture"],
                ["<wrong-scale/>", "Select that scale in capture setup before importing."],
            ]) {
                await evaluate(`(() => {
                    const input = document.querySelector('input[aria-label="Import normal loot position from gamevariable.xml"]');
                    const transfer = new DataTransfer();
                    transfer.items.add(new File([${JSON.stringify(contents)}], 'gamevariable.xml'));
                    input.files = transfer.files;
                    input.dispatchEvent(new Event('change', {bubbles:true}));
                })()`);
                await until(`document.body.textContent.includes(${JSON.stringify(message)})`);
                assert.deepEqual(
                    await evaluate(
                        "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection.settings",
                    ),
                    dragged,
                );
            }
            await click("Adjust automatically");
            await until(
                "window.__calls.some(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'search')",
            );
            const selection = await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'search').at(-1).args.selection",
            );
            assert.equal(selection.sourceWidth, sourceWidth);
            assert.equal(selection.sourceHeight, sourceHeight);
            assert.equal(selection.uiScalePercent, uiScale);
            // The 16 FPS trial evaluates normal search every fourth sample and rare search every second.
            await evaluate(`for (let i=0;i<12;i++) window.__emitSearch(${JSON.stringify(selection)})`);
            await until("document.body.textContent.includes('Auto-aligned')");
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'regions'",
            );
            const region = await evaluate(
                "window.__calls.filter(c => c.command === 'save_loot_capture_settings').at(-1).args.settings.region",
            );
            assert.ok(
                Math.abs(
                    Math.round(region.x * sourceWidth) -
                        (Math.round(selection.region.x * sourceWidth) + 219 + (uiScale === 80 ? 78 : 97)),
                ) <= 1,
            );
            assert.equal(Math.round(region.width * sourceWidth), uiScale === 80 ? 272 : 341);
            assert.equal(Math.round(region.height * sourceHeight), uiScale === 80 ? 180 : 226);
            assert.equal(
                Math.round(region.y * sourceHeight),
                Math.round(selection.region.y * sourceHeight) + 100 + (uiScale === 80 ? 36 : 44),
            );
            await click("Loot stack");
            await click("Adjust automatically");
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'search'",
            );
            const relocatedSelection = await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection",
            );
            await evaluate(`for (let i=0;i<12;i++) window.__emitSearch(${JSON.stringify(relocatedSelection)})`);
            await until("document.body.textContent.includes('Auto-aligned')");
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'regions'",
            );
            await click("Rare loot");
            await click("Adjust automatically");
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'search'",
            );
            await click("Adjust manually");
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'regions'",
            );
            await click("Adjust automatically");
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'search'",
            );
            const rareSelection = await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1).args.selection",
            );
            await evaluate(`for (let i=0;i<6;i++) window.__emitSearch(${JSON.stringify(rareSelection)},true)`);
            await until(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region').at(-1)?.args.selection?.mode === 'regions'",
            );
            // The rare search leaves the auto-aligned loot stack in place, so only the rare area needs confirming.
            await until("document.body.textContent.includes('Auto-aligned')");
            await click("Confirm rare area");
            await until(
                "window.__calls.filter(c => c.command === 'save_loot_capture_settings').at(-1)?.args.settings.rareRegionConfirmed === true",
            );
            const rareRegion = await evaluate(
                "window.__calls.filter(c => c.command === 'save_loot_capture_settings').at(-1).args.settings.rareRegion",
            );
            assert.equal(
                Math.round(rareRegion.x * sourceWidth),
                Math.round(rareSelection.region.x * sourceWidth) + (uiScale === 80 ? 252 : 265),
            );
            assert.equal(
                Math.round(rareRegion.y * sourceHeight),
                Math.round(rareSelection.region.y * sourceHeight) + (uiScale === 80 ? 220 : 225),
            );
            assert.equal(Math.round(rareRegion.width * sourceWidth), uiScale === 80 ? 340 : 425);
            assert.equal(Math.round(rareRegion.height * sourceHeight), uiScale === 80 ? 72 : 90);
            await until("[...document.querySelectorAll('button')].some(b => b.textContent === 'Set up capture')");
            await click("Set up capture");
            console.info(
                `Manual default, normal relocation, and rare search/cancel/confirm passed at ${source}, ${uiScale}% UI scale on ${backend}`,
            );
        }
        await evaluate("document.querySelector('#live-capture-heading').scrollIntoView({block:'start'})");
        await screenshot("capture-setup");
        await send("Emulation.setDeviceMetricsOverride", {
            width: 640,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await evaluate(
            "document.querySelector('fieldset[aria-label=\"Align loot areas\"]').scrollIntoView({block:'center'})",
        );
        assert(await evaluate(fitsWindow), "Capture setup must fit compact windows");
        assert(
            await evaluate(`(() => {
            const rect = (direction) => document.querySelector('[data-direction="' + direction + '"]').getBoundingClientRect();
            const up = rect('Up'), down = rect('Down'), left = rect('Left'), right = rect('Right');
            return up.x === down.x && left.y === right.y && up.bottom <= left.top && left.bottom <= down.top
                && left.right <= up.left && up.right <= right.left;
        })()`),
            "Direction buttons must form a cross at compact widths",
        );
        await screenshot("capture-controls-compact");
        await send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 820,
            deviceScaleFactor: 1,
            mobile: false,
        });

        await click("Advanced diagnostics");
        const sampledRate =
            "[...document.querySelectorAll('dt')].find(e => e.textContent === 'Sampled rate')?.nextElementSibling.textContent";
        await delay(1100);
        await evaluate("window.__emitFrame()");
        await until(`(${sampledRate})?.includes('FPS')`);
        const visibleRate = await evaluate(sampledRate);
        await click("Close setup");
        await delay(2100);
        await evaluate("window.__emitFrame()");
        await delay(100);
        assert.equal(await evaluate(sampledRate), visibleRate, "Hidden diagnostics must not keep refreshing");
        await until(
            "window.__calls.filter(c => c.command === 'set_native_display_capture_preview_enabled').at(-1)?.args.enabled === false",
        );
        await click("Set up capture");
        const savesBeforeWait = await evaluate("window.__calls.filter(c => c.command === 'save_session').length");
        await delay(1200);
        assert.equal(
            await evaluate("window.__calls.filter(c => c.command === 'save_session').length"),
            savesBeforeWait,
            "Timer ticks must not write session snapshots",
        );
        await evaluate(
            `window.__trendSamples = {"fixture-finished": [{elapsedMs: 900000, net: 12000000}, {elapsedMs: 2700000, net: 36000000}]}`,
        );
        await click("History");
        assert.equal(
            await evaluate("window.__calls.filter(c => c.command === 'stop_native_display_capture').length"),
            0,
            "Navigation must not stop capture",
        );
        await until(
            "window.__calls.filter(c => c.command === 'set_native_display_capture_preview_enabled').at(-1)?.args.enabled === false",
        );
        const ackCount = await evaluate(
            "window.__calls.filter(c => c.command === 'acknowledge_native_display_frame').length",
        );
        await evaluate("window.__emitFrame()");
        await until(
            `window.__calls.filter(c => c.command === 'acknowledge_native_display_frame').length > ${ackCount}`,
        );
        await screenshot("history");
        const historyTrend =
            "[...document.querySelectorAll('figure')].find(f => f.getClientRects().length && f.textContent.includes('Net over time'))";
        await until(`${historyTrend} !== undefined`);
        assert.match(
            await evaluate(`${historyTrend}.querySelector('[role="img"]').getAttribute('aria-label')`),
            /after 01:00:00/,
            "The receipt trend covers the whole session",
        );
        await evaluate(`${historyTrend}.querySelector('[role="img"]').focus()`);
        await press("Home", "Home", 36);
        await until(`${historyTrend}.querySelector('figcaption').textContent.includes('at 00:00:00')`);
        await press("End", "End", 35);
        await until(`${historyTrend}.querySelector('figcaption').textContent.includes('at 01:00:00')`);
        await press("Escape", "Escape", 27);
        await until(`!${historyTrend}.querySelector('figcaption').textContent.includes(' at ')`);
        const trendMiddle = await evaluate(`(() => {
            const rect = ${historyTrend}.querySelector('[role="img"]').getBoundingClientRect();
            return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        })()`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...trendMiddle });
        await until(`${historyTrend}.querySelector('figcaption').textContent.includes('at 00:30:00')`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
        assert.equal(
            await evaluate(
                'document.querySelector(\'[aria-label="Recorded region"] button[aria-pressed="true"]\')?.textContent',
            ),
            "EU",
            "Filters stay visible with the session region selected",
        );
        assert.equal(
            await evaluate(
                "document.querySelector('[aria-label=\"Grind spot comparisons\"]')?.textContent.includes('Rates weight sessions')",
            ),
            false,
            "History omits methodological prose",
        );
        for (const theme of ["dark", "light"]) {
            await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
            await screenshot(`history-filters-${theme}`);
        }
        await evaluate("document.documentElement.dataset.theme = 'dark'");
        await setHistoryFilter('select[aria-label="Grind spot"]', "stars-end-revamp");
        await until('document.body.textContent.includes("No sessions match these filters")');
        assert.equal(
            await evaluate("document.querySelector('[aria-label=\"Filtered history summary\"]') === null"),
            true,
            "Empty filters must not show totals from another profile",
        );
        await setHistoryFilter('select[aria-label="Grind spot"]', "all");
        await evaluate(`window.__historyRecords = Array.from({length:41}, (_,i) => ({
            session:{id:'history-'+String(i).padStart(2,'0'),status:'finished',region:'eu',grindSpotId:i === 0 ? 'stars-end-revamp' : 'sycraia-lower-revamp',startedAt:null,elapsedMs:i === 1 ? 0 : 3600000,
                entries:[{id:'entry-'+i,name:'Ancient Spirit Dust',quantity:1,unitPrice:100000000,valuation:'vendor',saleMultiplier:1,source:'manual',createdAt:Date.UTC(2026,8,1)}]},
            finishedAt:Date.UTC(2026,8,1)+i*86400000,garmothUploadStatus:null
        })); window.confirm = () => true;`);
        await click("Reload");
        await until('document.body.innerText.includes("1–20 of 41 sessions")');
        const selectHistoryRow = (index) =>
            evaluate(
                `[...document.querySelectorAll('button[aria-label^="Delete "]')][${index}].parentElement.querySelector('button[aria-pressed]').click()`,
            );
        await evaluate(
            `window.__trendSamples = {"history-39": [{elapsedMs: 1200000, net: 40000000}]}; window.__holdTrend = "history-39"`,
        );
        await selectHistoryRow(1);
        await until('typeof window.__releaseTrend === "function"');
        await selectHistoryRow(2);
        await until(
            "window.__calls.filter(c => c.command === 'load_session_trend' && c.args.sessionId === 'history-38').length > 0",
        );
        await evaluate("window.__releaseTrend()");
        await delay(100);
        assert.equal(
            await evaluate(`${historyTrend} === undefined`),
            true,
            "A late trend response must not draw another session's trend, and sessions without samples show none",
        );
        await selectHistoryRow(1);
        await until(`${historyTrend} !== undefined`);
        await setHistoryFilter('select[aria-label="Grind spot"]', "stars-end-revamp");
        await until('document.body.innerText.includes("1–1 of 1 sessions")');
        await setHistoryFilter('select[aria-label="Grind spot"]', "all");
        await until('document.body.innerText.includes("1–20 of 41 sessions")');
        const fullSummary = await evaluate(
            "document.querySelector('[aria-label=\"Filtered history summary\"]').innerText",
        );
        await click("Next");
        await until('document.body.innerText.includes("21–40 of 41 sessions")');
        await until('document.activeElement?.textContent === "Next"');
        assert.equal(
            await evaluate("document.querySelector('[aria-label=\"Filtered history summary\"]').innerText"),
            fullSummary,
            "Pagination must not change full-history totals",
        );
        await click("Next");
        await until('document.body.innerText.includes("41–41 of 41 sessions")');
        await click("Delete");
        await until('document.body.innerText.includes("21–40 of 40 sessions")');
        await until('document.activeElement?.getAttribute("aria-pressed") === "true"');
        await click("Previous");
        await until('document.body.innerText.includes("1–20 of 40 sessions")');
        await setHistoryFilter('select[aria-label="Grind spot"]', "stars-end-revamp");
        await until('document.body.innerText.includes("No sessions match these filters")');
        assert.equal(
            await evaluate("document.querySelector('[aria-label=\"Grind spot comparisons\"]') !== null"),
            true,
            "Spot filter must not remove comparisons for other spots",
        );
        await setHistoryFilter("region", "na");
        await until(
            'document.body.innerText.includes("No sessions match these filters") && document.querySelector(\'[aria-label="Grind spot comparisons"]\') === null',
        );
        await clearHistoryFilters();
        await until('document.body.innerText.includes("1–20 of 40 sessions")');
        await evaluate("window.__holdHistory = true");
        await click("Reload");
        await until('typeof window.__releaseHistory === "function"');
        await setHistoryFilter("region", "na");
        await until('document.body.innerText.includes("No sessions match these filters")');
        await evaluate("window.__releaseHistory()");
        await delay(100);
        assert.equal(
            await evaluate("document.querySelector('[aria-label=\"Grind spot comparisons\"]') === null"),
            true,
            "Late responses must not restore another region's results",
        );
        await clearHistoryFilters();
        await until('document.body.innerText.includes("1–20 of 40 sessions")');
        await setHistoryFilter('input[type="date"]', "2026-10-01");
        await until('document.body.innerText.includes("1–11 of 11 sessions")');
        await setHistoryFilter("#history-completed-through", "2026-09-01");
        await until('document.body.innerText.includes("The From date must be on or before the To date")');
        await clearHistoryFilters();
        await until('document.body.innerText.includes("1–20 of 40 sessions")');
        await evaluate("window.__failHistoryAfterDelete = true");
        await click("Delete");
        await until('document.body.innerText.includes("Session was deleted, but history could not be refreshed")');
        assert.equal(
            await evaluate("document.querySelector('[aria-label=\"Grind spot comparisons\"]') === null"),
            true,
            "Failed refresh must not show stale rankings",
        );
        await evaluate("window.__failHistory = false; window.__failHistoryAfterDelete = false");
        await click("Reload");
        await until('document.body.innerText.includes("1–20 of 39 sessions")');
        await screenshot("history-comparisons");
        await send("Emulation.setDeviceMetricsOverride", {
            width: 640,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await screenshot("history-comparisons-compact");
        await screenshot("history-filters-compact");
        assert.equal(
            await evaluate(
                '(() => { const r = document.querySelector("[aria-label=\\"Filters\\"]").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()',
            ),
            true,
            "Filters fit the viewport",
        );
        assert.equal(await evaluate(fitsWindow), true, "History must not overflow the viewport");
        await send("Emulation.setDeviceMetricsOverride", {
            width: 1280,
            height: 820,
            deviceScaleFactor: 1,
            mobile: false,
        });
        await click("Settings");
        await until("document.querySelector('#loot-font')?.disabled === false");
        assert.equal(await evaluate("document.querySelector('#loot-font').value"), "korean");
        await evaluate("window.__failLootFont = true");
        await setField("#loot-font", "strong-sword");
        await until("document.body.innerText.includes('Synthetic font save failure')");
        await evaluate("window.__failLootFont = false");
        await click("Retry save");
        await until(
            "window.__savedLootFont === 'strong-sword' && !document.body.innerText.includes('Synthetic font save failure')",
        );
        assert.equal(
            await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'regions').at(-1).args.selection.settings.font",
            ),
            "korean",
            "An active capture keeps its original font",
        );
        await click("Grind desk");
        await click("Settings");
        assert.equal(
            await evaluate("document.querySelector('#loot-font').value"),
            "strong-sword",
            "Font selection survives settings navigation",
        );
        await until("document.querySelector('#self-improvement-enabled')?.disabled === false");
        assert(
            await evaluate(
                '!!document.querySelector(\'[aria-label="Settings sections"] a[href="#self-improvement"]\')',
            ),
        );
        assert.equal(await evaluate("document.querySelector('#self-improvement-enabled').checked"), false);
        await evaluate("document.querySelector('#self-improvement-enabled').click()");
        await until(
            "window.__selfImprovement.enabled === true && !document.querySelector('#self-improvement-enabled').disabled",
        );
        await click("Grind desk");
        assert.equal(
            await evaluate("document.querySelectorAll('#self-improvement').length"),
            0,
            "Controls live only in Settings",
        );
        await click("Settings");
        await until("document.querySelector('#self-improvement-enabled')?.checked === true");
        await evaluate("document.querySelector('#self-improvement-enabled').click()");
        await until("window.__selfImprovement.enabled === false");
        await evaluate("document.getElementById('self-improvement').scrollIntoView({block:'start'})");
        await screenshot("self-improvement-settings");
        await screenshot("settings");
        await click("Go to capture setup");
        await until("document.activeElement.textContent.includes('Close setup')");
        assert.equal(
            await evaluate("window.__calls.filter(c => c.command === 'start_native_display_capture').length"),
            1,
            "Capture navigation must reuse the active source",
        );
        await click("Grind desk");
        await until(
            "window.__calls.filter(c => c.command === 'set_native_display_capture_preview_enabled').at(-1)?.args.enabled === true",
        );
        await evaluate("window.__minimized = true; window.__resize()");
        await until(
            "window.__calls.filter(c => c.command === 'set_native_display_capture_preview_enabled').at(-1)?.args.enabled === false",
        );
        assert.equal(
            await evaluate("window.__calls.filter(c => c.command === 'stop_native_display_capture').length"),
            0,
            "Minimization must not stop capture",
        );
        await evaluate("window.__minimized = false; window.__resize()");
        await until(
            "window.__calls.filter(c => c.command === 'set_native_display_capture_preview_enabled').at(-1)?.args.enabled === true",
        );
        await click("Close setup");
        if (Number(process.env.UI_SMOKE_SOAK_SECONDS) > 0) {
            const seconds = Number(process.env.UI_SMOKE_SOAK_SECONDS);
            const before = await evaluate(
                "window.__calls.filter(c => c.command === 'acknowledge_native_display_frame').length",
            );
            await evaluate("window.__soak = setInterval(window.__emitFrame, 62.5)");
            await delay(seconds * 1000);
            await evaluate("clearInterval(window.__soak)");
            const after = await evaluate(
                "window.__calls.filter(c => c.command === 'acknowledge_native_display_frame').length",
            );
            assert(after - before >= seconds * 14, "Sustained synthetic frame delivery stalled");
            assert.equal(
                await evaluate("window.__calls.filter(c => c.command === 'stop_native_display_capture').length"),
                0,
            );
            console.log(`Synthetic capture soak: ${after - before} frames acknowledged over ${seconds}s`);
        }
        await screenshot("desk-running");
        await click("Finish");
        await until("window.__calls.filter(c => c.command === 'stop_native_display_capture').length === 1");
        await evaluate("window.__emitFrame()");
        await delay(100);
        assert(
            await evaluate("document.body.textContent.includes('Capture off')"),
            "Late frames must not revive a finished capture",
        );
        assert(
            await evaluate("document.body.textContent.includes('Could not decode screenshot')"),
            "Navigation must preserve screenshot state within the same session",
        );
        await click("New session");
        assert(
            await evaluate("!document.body.textContent.includes('Could not decode screenshot')"),
            "A new session must clear previous screenshot state",
        );
        await click("Add loot or expense");
        await screenshot("manual-entry");
        await evaluate(
            "[...document.querySelectorAll('button[type=submit]')].find(b=>b.textContent.includes('Add to ledger')).click()",
        );
        await until("window.__session.entries.length === 1");
        assert.equal(await evaluate("window.__session.entries[0].quantity"), 1);
        await until("document.querySelector('dialog[open] form [role=status]')?.textContent.includes('Added')");
        await setField('dialog[open] input[min="1"]', "2");
        assert(
            !(await evaluate("document.querySelector('dialog[open] form [role=status]')")),
            "Editing the draft must clear the previous success message",
        );
        await setField('dialog[open] input[type="search"]', "no matching loot");
        await click("Clear search");
        assert.equal(await evaluate("document.activeElement.type"), "search");
        await evaluate("document.querySelector('[aria-label=\"Close manual entry\"]').click()");
        await click("Ledger");
        const quantitySelector = 'input[aria-label^="Quantity for"]';
        const priceSelector = 'input[aria-label^="Unit price for"]';
        const lootQuantityLabel = await evaluate(
            `document.querySelector('${quantitySelector}').getAttribute('aria-label')`,
        );
        const quantityRateCell = `[...document.querySelectorAll('${quantitySelector}')].find(input => input.getAttribute('aria-label') === ${JSON.stringify(lootQuantityLabel)}).closest('tr').cells[2]`;
        assert.equal(await evaluate(`${quantityRateCell}.textContent`), "—", "Zero elapsed time has no rate");
        await evaluate(`document.querySelector('${quantitySelector}').focus()`);
        await setField(quantitySelector, "25");
        await press("Enter", "Enter", 13);
        await until("window.__session.entries[0].quantity === 25");
        await evaluate(`document.querySelector('${quantitySelector}').focus()`);
        await setField(quantitySelector, "99");
        await press("Escape", "Escape", 27);
        await evaluate("document.activeElement.blur()");
        assert.equal(await evaluate("window.__session.entries[0].quantity"), 25, "Escape must cancel an edit");
        const priceBefore = await evaluate("window.__session.entries[0].unitPrice");
        await evaluate(`document.querySelector('${priceSelector}').focus()`);
        await setField(priceSelector, "");
        await press("Enter", "Enter", 13);
        await until("document.body.textContent.includes('Edit not saved')");
        assert.equal(
            await evaluate("window.__session.entries[0].unitPrice"),
            priceBefore,
            "A blank price must not become zero",
        );
        await evaluate(`document.querySelector('${priceSelector}').focus()`);
        await press("Escape", "Escape", 27);
        await evaluate("document.activeElement.blur()");
        await click("Add loot or expense");
        assert(
            await evaluate("document.querySelector('dialog[open]').contains(document.activeElement)"),
            "Dialog must receive keyboard focus",
        );
        await setField('dialog[open] input[min="1"]', "9007199254740991");
        await evaluate("document.querySelector('dialog[open] form').requestSubmit()");
        await until("document.querySelector('dialog[open] [role=alert]')?.textContent.includes('combined quantity')");
        assert.equal(
            await evaluate("window.__session.entries[0].quantity"),
            25,
            "Rejected combined quantities must preserve existing loot",
        );
        await evaluate(
            "[...document.querySelectorAll('dialog[open] button[aria-pressed]')].find(b => b.querySelector('strong')?.textContent === 'Black Stone').click()",
        );
        await click("Expense");
        await setField('dialog[open] input[placeholder="e.g. Elixir rotation"]', "Elixir rotation");
        await setField('dialog[open] input[placeholder="Required"]', "5000");
        await evaluate("document.querySelector('dialog[open] form').requestSubmit()");
        await until("window.__session.entries.length === 2");
        await until("document.querySelector('dialog[open] [role=status]')?.textContent.includes('Elixir rotation')");
        assert.equal(
            await evaluate("window.__session.entries.find(e => e.name === 'Elixir rotation').valuation"),
            "expense",
        );
        // Escape from the dialog's close control exercises the browser's native dismissal and focus restoration.
        await evaluate("document.querySelector('[aria-label=\"Close manual entry\"]').focus()");
        await press("Escape", "Escape", 27);
        await until("!document.querySelector('dialog[open]')");
        assert(
            await evaluate("document.activeElement.textContent.includes('Add loot or expense')"),
            "Dismissal must restore the opener",
        );
        await click("Settings");
        await until("document.querySelector('#market').textContent.includes('No EU prices saved')");
        await click("Fetch EU prices");
        await until("document.querySelector('#market').textContent.includes('EU prices from')");
        await setField('#market select[aria-label="Region"]', "na");
        await until("window.__session.region === 'na'");
        await until("document.querySelector('#market').textContent.includes('Using EU prices from')");
        await click("Fetch NA prices");
        await until("document.querySelector('#market').textContent.includes('NA prices from')");
        const savedPrices = await evaluate("JSON.stringify(window.__marketPrices.na)");
        await evaluate("window.__failPrices = true");
        await click("Refresh prices");
        await until(
            "document.querySelector('#market').textContent.includes('Refresh failed; saved prices are unchanged.')",
        );
        assert.equal(await evaluate("JSON.stringify(window.__marketPrices.na)"), savedPrices);
        await evaluate("window.__failPrices = false");
        await click("Refresh prices");
        await until(
            "!document.querySelector('#market select').disabled && !document.querySelector('#market').textContent.includes('Synthetic price failure')",
        );
        await click("Grind desk");
        await click("Add loot or expense");
        assert.equal(
            await evaluate("document.querySelector('dialog[open] input[placeholder=Required]').value"),
            "5000",
            "Changing market region must preserve an expense draft's price",
        );
        await click("Close manual entry");
        const entriesBeforeFilter = await evaluate("JSON.stringify(window.__session.entries)");
        await setField('input[placeholder="Search recorded items…"]', "elixir");
        await until("document.querySelector('tbody').rows.length === 1");
        assert(await evaluate("document.querySelector('tbody').textContent.includes('Elixir rotation')"));
        await setField('input[placeholder="Search recorded items…"]', "missing");
        await until("document.body.textContent.includes('No matching entries')");
        await click("Clear filters");
        await setField("[id^=ledger-filter-]", "expense");
        assert.equal(await evaluate('document.querySelector("tbody").rows.length'), 1);
        assert.equal(
            await evaluate("JSON.stringify(window.__session.entries)"),
            entriesBeforeFilter,
            "Filtering must not mutate accounting",
        );
        await setField("[id^=ledger-filter-]", "all");
        await click("Enter hours");
        await setField('input[name="hours"]', "1");
        await setField('input[name="minutes"]', "30");
        await setField('input[name="seconds"]', "0");
        await click("Save hours");
        await until("window.__session.elapsedMs === 5400000");
        assert.equal(
            await evaluate(`${quantityRateCell}.textContent`),
            "16.67",
            "Quantity/h must use the edited quantity and manually entered hours",
        );
        assert(
            await evaluate(
                "document.activeElement.textContent === 'Enter hours' && !document.activeElement.parentElement.open",
            ),
            "Saving hours closes the form and restores focus",
        );
        await click("Start timer");
        await evaluate(`document.querySelector('${quantitySelector}').focus()`);
        await setField(quantitySelector, "99");
        await until(`Number(${quantityRateCell}.textContent) < 16.67`);
        assert.equal(
            await evaluate(`document.querySelector('${quantitySelector}').value`),
            "99",
            "Timer ticks must preserve an unfinished quantity edit",
        );
        await press("Escape", "Escape", 27);
        await evaluate("document.activeElement.blur()");
        await click("Pause timer");
        await until("window.__session.status === 'paused'");
        const pausedQuantityRate = await evaluate(`${quantityRateCell}.textContent`);
        await delay(1_100);
        assert.equal(
            await evaluate(`${quantityRateCell}.textContent`),
            pausedQuantityRate,
            "Quantity/h must stay fixed while paused",
        );
        await click("Resume timer");
        await until("window.__session.status === 'running'");
        await click("Pause timer");
        await until("window.__session.status === 'paused'");
        await click("Settings");
        for (const theme of ["light", "dark"]) {
            await evaluate(`document.querySelector('input[name="theme"][value="${theme}"]').click()`);
            await click("Grind desk");
            await screenshot(`desk-${theme}`);
            await click("Settings");
        }
        await click("Grind desk");
        for (const width of [960, 700, 640]) {
            await send("Emulation.setDeviceMetricsOverride", {
                width,
                height: width === 960 ? 680 : 420,
                deviceScaleFactor: 1,
                mobile: false,
            });
            await screenshot(`minimum-window-${width}`);
            assert(await evaluate(fitsWindow), `Window at ${width}px must not overflow horizontally`);
            await click("Add loot or expense");
            assert(
                await evaluate(
                    `document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth`,
                ),
                "Entry dialog must fit compact windows",
            );
            await evaluate("document.querySelector('dialog[open]').scrollTop = 10000");
            assert(
                await evaluate(`(() => {
                    const dialog = document.querySelector('dialog[open]').getBoundingClientRect();
                    const close = document.querySelector('[aria-label="Close manual entry"]').getBoundingClientRect();
                    return close.top >= dialog.top && close.bottom <= dialog.bottom;
                })()`),
                "Entry dialog dismissal must remain visible after scrolling in short windows",
            );
            await evaluate("document.querySelector('dialog[open]').scrollTop = 0");
            if (width === 640) await screenshot("manual-entry-compact");
            await evaluate("document.querySelector('[aria-label=\"Close manual entry\"]').click()");
            for (const view of ["History", "Settings"]) {
                await click(view);
                assert(await evaluate(fitsWindow), `${view} must fit at ${width}px`);
                if (width === 640) await screenshot(`${view.toLowerCase()}-compact`);
            }
            await click("Grind desk");
        }
        await setField("[id^=ledger-filter-]", "expense");
        await setField('input[placeholder="Search recorded items…"]', "elixir");
        await click("Finish");
        await click("New session");
        await until("window.__session.status === 'idle' && window.__session.entries.length === 0");
        await click("Add loot or expense");
        assert.equal(
            await evaluate("document.querySelector('dialog[open] form select').value"),
            "vendor",
            "A new session must reset the previous expense draft",
        );
        assert.equal(await evaluate("document.querySelector('dialog[open] input[min=\"1\"]').value"), "1");
        assert.equal(
            await evaluate("document.querySelector('dialog[open] input[placeholder=Required]').value"),
            "107900",
        );
        await evaluate("document.querySelector('dialog[open] form').requestSubmit()");
        await until("window.__session.entries.length === 1");
        await click("Close manual entry");
        assert.equal(await evaluate("document.querySelector('[id^=ledger-filter-]').value"), "all");
        assert.equal(
            await evaluate("document.querySelector('input[placeholder=\"Search recorded items…\"]').value"),
            "",
        );
        assert.equal(
            await evaluate("document.querySelector('tbody').rows.length"),
            1,
            "New loot must not be hidden by the previous session's filters",
        );
        await click("Choose capture source");
        await until("window.__calls.filter(c => c.command === 'start_native_display_capture').length === 2");
        await until(
            "window.__calls.filter(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'regions').at(-1)?.args.selection.settings.font === 'strong-sword'",
        );
        await click("Settings");
        await setField("#loot-font", "korean");
        await until("window.__savedLootFont === 'korean'");
        assert.equal(
            await evaluate(
                "window.__calls.filter(c => c.command === 'set_native_display_capture_region' && c.args.selection?.mode === 'regions').at(-1).args.selection.settings.font",
            ),
            "strong-sword",
            "Changing back to Korean does not mutate Strong Sword capture",
        );
        await click("Grind desk");
        await click("Start timer");
        const confirmation = await evaluate(
            "[...document.querySelectorAll('button')].find(b => /^Confirm (both areas|rare area)$/.test(b.textContent.trim()) && !b.disabled)?.textContent.trim()",
        );
        if (confirmation) {
            await click(confirmation);
            await until("document.querySelector('#capture-setup').hidden");
        } else {
            assert(
                await evaluate(
                    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Both areas confirmed' && b.disabled)",
                ),
                "Skipping confirmation requires both areas to already be confirmed",
            );
        }
        if (hasRecognitionProfile) {
            // Keep the synthetic source updating while OCR starts or restarts after a native frame gap.
            await evaluate("window.__emitLoot(0)");
            // Let the first frame publish any restart before consulting the rendered status.
            await delay(65);
            await until(
                "(() => { window.__emitLoot(0); return document.querySelector('[data-recognition-status=active]') !== null; })()",
            );
            for (let rows = 1; rows <= 3; rows++) {
                for (let frame = 0; frame < 16; frame++) {
                    await evaluate(`window.__emitLoot(${rows})`);
                    await delay(65);
                }
            }
            const reviewEntries = "document.querySelectorAll('[data-review-entry]')";
            // Three real local OCR jobs can exceed the ordinary UI update deadline on slower hosts.
            const reviewStartedAt = Date.now();
            await until(`${reviewEntries}.length === 3`, 30_000);
            console.info(`Synthetic OCR review completed in ${Date.now() - reviewStartedAt} ms`);
            const entriesBeforeReview = await evaluate("window.__session.entries.length");
            await click("Retry OCR");
            await click("Dismiss");
            await until(`${reviewEntries}.length === 2`);
            await delay(300);
            assert.equal(
                await evaluate("window.__session.entries.length"),
                entriesBeforeReview,
                "Dismissing a retry must not add loot",
            );
            await click(await evaluate("document.querySelector('header button[aria-label$=attention]').ariaLabel"));
            assert.equal(await evaluate("document.activeElement.id"), "loot-review-heading");
            assert.equal(
                await evaluate("document.scrollingElement.scrollTop"),
                0,
                "Opening review from the title bar must keep the title bar in view",
            );
            // Finish while a new notification is still being tracked, before its OCR result.
            for (let frame = 0; frame < 4; frame++) {
                await evaluate("window.__emitLoot(4)");
                await delay(65);
            }
            await click("Finish");
            await until("document.querySelector('#finish-review-title')?.textContent === 'Review before finishing'");
            await until("window.__session.status === 'paused'");
            assert.equal(
                await evaluate(`${reviewEntries}.length`),
                3,
                "Finishing must drain the final notification and retain unresolved captures",
            );
            assert(await evaluate("document.querySelector('dialog[open]').contains(document.activeElement)"));
            await screenshot("finish-review");
            await press("Escape", "Escape", 27);
            assert.equal(await evaluate("window.__session.status"), "paused", "Escape must keep the session open");
            await click("Finish");
            await until("document.querySelector('#finish-review-title')?.textContent === 'Review before finishing'");
            await click("Review drops");
            assert.equal(await evaluate("document.activeElement.id"), "loot-review-heading");
            const reviewForm = "document.querySelector('#loot-review-detail form')";
            await evaluate(`(${reviewForm}).querySelector('select').setAttribute('id','review-item-test')`);
            await evaluate(`(${reviewForm}).querySelector('input').setAttribute('id','review-quantity-test')`);
            await setField("#review-item-test", "Ancient Spirit Dust");
            await setField("#review-quantity-test", "2");
            await evaluate(`(${reviewForm}).requestSubmit()`);
            await until(`${reviewEntries}.length === 2`);
            await until("window.__session.entries.some(e=>e.name==='Ancient Spirit Dust' && e.quantity===2)");
            await click("Finish");
            await until("document.querySelector('#finish-review-title')?.textContent === 'Review before finishing'");
            await click("Finish without adding these drops");
            await until("window.__session.status === 'finished'");
            assert.equal(
                await evaluate("window.__session.entries.length"),
                entriesBeforeReview + 1,
                "Finishing must not add dismissed or unresolved drops",
            );
            assert.equal(await evaluate(`${reviewEntries}.length`), 0);
        } else {
            await until("document.querySelector('[data-recognition-status=unavailable]') !== null");
            await click("Set up capture");
            await evaluate("window.__emitFrame()");
            await until("document.querySelector('[aria-label=\"Sampled capture preview\"]')?.width === 640");
            const diagnosticsOpen = await evaluate(
                "[...document.querySelectorAll('summary')].find(s => s.textContent === 'Advanced diagnostics').parentElement.open",
            );
            if (!diagnosticsOpen) await click("Advanced diagnostics");
            assert(await evaluate("document.body.textContent.includes('No calibrated profile')"));
            assert(
                await evaluate(
                    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Both areas confirmed' && b.disabled)",
                ),
                "A source without an OCR profile still supports confirmed area placement",
            );
            const entriesBeforePreview = await evaluate("JSON.stringify(window.__session.entries)");
            await evaluate("window.__emitLoot(0)");
            for (let frame = 0; frame < 16; frame++) {
                await evaluate("window.__emitLoot(1)");
                await delay(65);
            }
            assert(
                await evaluate("document.querySelector('[data-recognition-status=unavailable]') !== null"),
                "An uncalibrated source must remain preview-only after receiving loot frames",
            );
            assert.equal(await evaluate("document.querySelectorAll('[data-review-entry]').length"), 0);
            assert.equal(await evaluate("JSON.stringify(window.__session.entries)"), entriesBeforePreview);
            await screenshot("capture-preview-only");
            await click("Close setup");
            await click("Finish");
            await until("window.__session.status === 'finished'");
        }
        await click("Settings");
        assert(await evaluate("document.querySelector('#market select').disabled"));
        assert(await evaluate("document.querySelector('#market [aria-label=\"Grind spot\"] button').disabled"));
        assert(await evaluate("document.querySelector('#region-locked').textContent.includes('Start a new session')"));
        await evaluate("window.dispatchEvent(new Event('shakatu-stop-capture'))");
        assert.equal(errors.length, 0, JSON.stringify(errors));
        await send("Page.navigate", { url: `${appUrl}?history-startup=1` });
        await until('typeof window.__restoreHistorySession === "function"');
        await click("History");
        await until("document.querySelector('[aria-label=\"Filters\"]')?.disabled === true");
        await evaluate(
            `window.__restoreHistorySession({id:'restored-na',status:'paused',region:'na',grindSpotId:'sycraia-lower-revamp',startedAt:null,elapsedMs:1000,entries:[]})`,
        );
        await until(
            'window.__calls.filter(c => c.command === "list_finished_sessions").at(-1)?.args.query.region === "na"',
        );
        await until(
            "document.querySelector('[aria-label=\"Recorded region\"] button[aria-pressed=\"true\"]')?.textContent === 'NA'",
        );
        await setHistoryFilter("region", "eu");
        await until(
            'window.__calls.filter(c => c.command === "list_finished_sessions").at(-1)?.args.query.region === "eu"',
        );
        await clearHistoryFilters();
        await until(
            'window.__calls.filter(c => c.command === "list_finished_sessions").at(-1)?.args.query.region === "na"',
        );
        await send("Page.navigate", { url: `${appUrl}?preference-load-failure=1` });
        await until("window.__session?.status === 'idle'");
        await click("Browse all spots");
        await until(
            "document.querySelector('dialog[open]')?.textContent.includes('Could not load grind spot favorites')",
        );
        assert(
            await evaluate("document.querySelector('dialog[open] button[aria-label^=\"Star \"]').disabled"),
            "Favorites stay read-only while they failed to load",
        );
        await evaluate(
            "window.__preferencesAvailable = true; window.__spotPreferences = {favorites:['stars-end-revamp'],recent:[]}",
        );
        await click("Retry");
        await until(
            "!document.querySelector('dialog[open]').textContent.includes('Could not load grind spot favorites')",
        );
        await click("Favorites");
        await until("document.querySelector('dialog[open]').textContent.includes(\"Star's End\")");
        await click("Close spot browser");
        await evaluate("window.__preferencesAvailable = false");
        await click("Settings");
        await until("document.body.textContent.includes('Could not load theme')");
        await evaluate("window.__preferencesAvailable = true; window.__theme = 'light'");
        await click("Retry loading");
        await until(
            "document.documentElement.dataset.theme === 'light' && !document.body.textContent.includes('Could not load theme')",
        );
        assert(
            !(await evaluate("window.__calls.some(c => c.command === 'save_theme')")),
            "Retrying a failed theme load must reload, not save the default theme",
        );
        await send("Page.navigate", { url: `${appUrl}?supplemental-drops=1` });
        await until("window.__session?.status === 'idle'");
        await click("Settings");
        await click("Fetch EU prices");
        await until("document.querySelector('#market').textContent.includes('EU prices from')");
        assert(
            await evaluate(
                "window.__calls.find(c => c.command === 'fetch_market_prices').args.itemIds.includes(50807)",
            ),
            "Shared market items must be included in price lookup",
        );
        await click("Grind desk");
        await click("Add loot or expense");
        const supplementalNames = ["Laila's Petal", "Pure Forest Breath", "[Event] Bountiful Autumn Lunchbox"];
        for (const [index, name] of supplementalNames.entries()) {
            await setField('dialog[open] input[type="search"]', name);
            await until(
                "document.querySelectorAll('dialog[open] [aria-label$=\"loot items\"] button[aria-pressed]').length === 1",
            );
            await evaluate(
                "document.querySelector('dialog[open] [aria-label$=\"loot items\"] button[aria-pressed]').click()",
            );
            await setField('dialog[open] input[min="1"]', "2");
            await evaluate("document.querySelector('dialog[open] form').requestSubmit()");
            await until(`window.__session.entries.length === ${index + 1}`);
        }
        assert.deepEqual(
            await evaluate(
                "window.__session.entries.map(({name,quantity,unitPrice,valuation}) => ({name,quantity,unitPrice,valuation}))",
            ),
            supplementalNames.map((name, index) => ({
                name,
                quantity: 2,
                unitPrice: [500_000, 12_345, 10_000_000][index],
                valuation: index === 1 ? "market" : "vendor",
            })),
        );
        await setField('dialog[open] input[type="search"]', "Black Stone");
        await evaluate(
            "[...document.querySelectorAll('dialog[open] button[aria-pressed]')].find(b => b.querySelector('strong')?.textContent === 'Black Stone').click()",
        );
        await setField('dialog[open] input[min="1"]', "3");
        await evaluate("document.querySelector('dialog[open] form').requestSubmit()");
        await until("window.__session.entries.length === 4");
        await click("Close manual entry");
        await click("Enter hours");
        await setField('input[name="hours"]', "1");
        await setField('input[name="minutes"]', "0");
        await setField('input[name="seconds"]', "0");
        await click("Save hours");
        await click("Finish");
        await until("window.__session.status === 'finished'");
        const supplementalEntries = await evaluate("JSON.stringify(window.__session.entries)");
        await evaluate(
            "window.__historyRecords = [{session:window.__session,finishedAt:Date.now(),garmothUploadStatus:null}]",
        );
        await click("History");
        await until("document.body.innerText.includes('Session totals still include these items.')");
        assert(
            await evaluate(
                "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Upload to Garmoth' && !b.disabled)",
            ),
            "Supplemental drops outside the spot table must not block upload",
        );
        assert.equal(await evaluate("JSON.stringify(window.__session.entries)"), supplementalEntries);
        await click("Upload to Garmoth");
        await until(
            "document.querySelector('dialog[open]')?.innerText.includes('Session totals still include these items.')",
        );
        await screenshot("supplemental-upload-review");
        const buffHeading =
            "[...document.querySelectorAll('dialog[open] h2')].find(h => h.textContent === 'Drop buffs')";
        const pressedBuffs = `[...${buffHeading}.closest('section').querySelectorAll('button[aria-pressed="true"]')].map(b => b.textContent.trim()).join(',')`;
        const buffTotals = `JSON.stringify([...${buffHeading}.nextElementSibling.querySelectorAll('div')].map(d => d.textContent))`;
        assert.equal(
            await evaluate(pressedBuffs),
            "Lv. 2,[Camp] Adventurer's Luck V",
            "The last used buffs are preselected",
        );
        assert.equal(await evaluate(buffTotals), JSON.stringify(["Drop amount+100%", "Drop rate+150%"]));
        await click("[Camp] Adventurer's Luck III");
        await click("None");
        await click("Lv. 1");
        await click("Blessing of Old Moon Scroll");
        assert.equal(
            await evaluate(pressedBuffs),
            "Lv. 1,[Camp] Adventurer's Luck III,Blessing of Old Moon Scroll",
            "One tier of each buff stays selected",
        );
        assert.equal(await evaluate(buffTotals), JSON.stringify(["Drop amount+150%", "Drop rate+230%"]));
        await click("Upload to Garmoth");
        await until("window.__calls.some(c => c.command === 'upload_garmoth_session')");
        const upload = await evaluate("window.__calls.find(c => c.command === 'upload_garmoth_session').args.input");
        for (const key of ["54031_0", "50807_0", "1000835_0"]) assert.equal(key in upload.drops, false);
        assert.equal(upload.drops["16001_0"], 3);
        assert.equal(upload.total, Math.round(21_000_000 + 5 * 12_345 * 0.845));
        assert.equal(upload.hourly, upload.total);
        assert.equal(JSON.stringify(upload.expectedSession.entries), supplementalEntries);
        assert.deepEqual(
            [...upload.buffs].sort((a, b) => a - b),
            [1, 10, 138],
        );
        assert.equal("rate" in upload, false, "Rust derives the drop rate from the buffs");
        await until("!document.querySelector('dialog[open]')");
        assert.equal(await evaluate("JSON.stringify(window.__session.entries)"), supplementalEntries);
        assert.equal(errors.length, 0, JSON.stringify(errors));
        console.log(
            `UI smoke passed: timer, navigation, capture lifecycle, preview suppression, diagnostics, screenshot state, dialog focus, expense price isolation, new-session reset, ledger editing/filtering, history filters, themes, compact screens. Screenshots: ${output}`,
        );
    }
} finally {
    ws.close();
    await fetch(`http://127.0.0.1:9222/json/close/${page.id}`);
}
