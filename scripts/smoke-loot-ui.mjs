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
async function until(expression) {
    for (let i = 0; i < 100; i++) {
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
            const button = [...document.querySelectorAll('button,summary')].find(b => b.textContent.trim().replace(/\\s+/g, ' ') === ${JSON.stringify(text)} && b.getClientRects().length);
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
async function press(key, code, windowsVirtualKeyCode) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
}
await send("Runtime.enable");
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    localStorage.clear();
    window.isTauri = true;
    const calls = window.__calls = [];
    const callbacks = new Map();
    let nextCallbackId = 0;
    const listeners = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(event, id) { listeners.delete(id); } };
    window.__resize = () => { for (const [id, args] of listeners) if (args.event === "tauri://resize") callbacks.get(args.handler)?.({event: args.event, payload:{width:1280,height:820}, id}); };
    window.__minimized = false;
    window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback(fn) { const id = ++nextCallbackId; callbacks.set(id, fn); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
            calls.push({ command, args });
            if (command === "load_active_session") return null;
            if (command === "load_market_prices") return [];
            if (command === "list_finished_sessions") return [{ session: {id:"fixture-finished",status:"finished",region:"eu",grindSpotId:"sycraia-lower-revamp",startedAt:null,elapsedMs:3600000,entries:[{id:"fixture-loot",name:"Ancient Spirit Dust",quantity:12,unitPrice:3000000,valuation:"vendor",saleMultiplier:1,source:"manual",createdAt:1788520000000}]},finishedAt:1788523600000,garmothUploadStatus:null }];
            if (command === "native_capture_capabilities") return { backend: ${JSON.stringify(backend)}, available: true, reason: null, debugRoiSamples: true };
            if (command === "load_loot_capture_settings") return null;
            if (command === "load_garmoth_settings") return { apiKeyConfigured: false, characterIds: [], characters: [], selectedCharacterId: null };
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
                setTimeout(window.__emitFrame,50);
                return;
            }
            if (command === "plugin:window|is_minimized") return window.__minimized;
            if (command === "plugin:event|listen") { const id = args.handler; listeners.set(id, args); return id; }
            if (command === "debug_roi_sample_collection_status") throw new Error("Debug collection unavailable in test");
            if (["acknowledge_native_display_frame", "set_native_display_capture_region", "set_native_display_capture_preview_enabled", "stop_native_display_capture", "save_loot_capture_settings", "plugin:event|unlisten"].includes(command)) return;
            throw new Error("Unexpected test command: " + command);
        }
    };
`,
});
try {
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: appUrl });
    await until("document.querySelector('button.primary-button')?.disabled === false");
    if (process.env.UI_SCREENSHOT_ONLY !== "1") assert(await evaluate("!document.querySelector('details').open"));
    await mkdir(output, { recursive: true });
    async function screenshot(name) {
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(`${output}/${name}.png`, Buffer.from(data, "base64"));
    }
    await screenshot("desk-idle");
    if (process.env.UI_SCREENSHOT_ONLY === "1") {
        console.log(`Screenshot saved: ${output}/desk-idle.png`);
    } else {
        await click("Import a screenshot Marni tracker");
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
                Math.abs(Math.round(region.x * sourceWidth) - (Math.round(selection.region.x * sourceWidth) + 219)) <=
                    1,
            );
            assert.equal(Math.round(region.width * sourceWidth), uiScale === 80 ? 362 : 453);
            assert.equal(Math.round(region.height * sourceHeight), uiScale === 80 ? 311 : 389);
            assert.equal(Math.round(region.y * sourceHeight), Math.round(selection.region.y * sourceHeight) + 100);
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
            await click("Confirm both areas");
            await until(
                "window.__calls.filter(c => c.command === 'save_loot_capture_settings').at(-1)?.args.settings.rareRegionConfirmed === true",
            );
            const rareRegion = await evaluate(
                "window.__calls.filter(c => c.command === 'save_loot_capture_settings').at(-1).args.settings.rareRegion",
            );
            assert.equal(
                Math.round(rareRegion.x * sourceWidth),
                Math.round(rareSelection.region.x * sourceWidth) + 200,
            );
            assert.equal(
                Math.round(rareRegion.y * sourceHeight),
                Math.round(rareSelection.region.y * sourceHeight) + 200,
            );
            assert.equal(Math.round(rareRegion.width * sourceWidth), uiScale === 80 ? 400 : 500);
            assert.equal(Math.round(rareRegion.height * sourceHeight), uiScale === 80 ? 100 : 125);
            await until("[...document.querySelectorAll('button')].some(b => b.textContent === 'Set up capture')");
            await click("Set up capture");
            console.info(
                `Manual default, normal relocation, and rare search/cancel/confirm passed at ${source}, ${uiScale}% UI scale on ${backend}`,
            );
        }
        await evaluate("document.querySelector('#live-capture-heading').scrollIntoView({block:'start'})");
        await screenshot("capture-setup");
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
        await setField("main > header select", "stars-end-revamp");
        await until('document.body.textContent.includes("No Star\'s End sessions")');
        assert.equal(
            await evaluate("document.querySelector('[aria-label=\"Filtered history summary\"]') === null"),
            true,
            "Empty filters must not show totals from another profile",
        );
        await setField("main > header select", "all");
        await click("Settings");
        await screenshot("settings");
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
        await click("Add loot or expense Manual entry");
        await screenshot("manual-entry");
        await evaluate(
            "[...document.querySelectorAll('button[type=submit]')].find(b=>b.textContent.includes('Add to ledger')).click()",
        );
        await until("window.__session.entries.length === 1");
        assert.equal(await evaluate("window.__session.entries[0].quantity"), 1);
        await evaluate("document.querySelector('[aria-label=\"Close manual entry\"]').click()");
        const quantitySelector = 'input[aria-label^="Quantity for"]';
        const priceSelector = 'input[aria-label^="Unit price for"]';
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
        await click("Add loot or expense Manual entry");
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
        await click("Record an expense");
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
        const entriesBeforeFilter = await evaluate("JSON.stringify(window.__session.entries)");
        await setField('input[placeholder="Search recorded items…"]', "elixir");
        await until("document.querySelector('tbody').rows.length === 1");
        assert(await evaluate("document.querySelector('tbody').textContent.includes('Elixir rotation')"));
        await setField('input[placeholder="Search recorded items…"]', "missing");
        await until("document.body.textContent.includes('No matching entries')");
        await click("Clear filters");
        await setField('[aria-labelledby="ledger-heading"] select', "expense");
        assert.equal(await evaluate('document.querySelector("tbody").rows.length'), 1);
        assert.equal(
            await evaluate("JSON.stringify(window.__session.entries)"),
            entriesBeforeFilter,
            "Filtering must not mutate accounting",
        );
        await setField('[aria-labelledby="ledger-heading"] select', "all");
        await click("Enter hours");
        await setField('input[name="completedHours"]', "1.5");
        await click("Save hours");
        await until("window.__session.elapsedMs === 5400000");
        assert(
            await evaluate(
                "document.activeElement.textContent === 'Enter hours' && !document.activeElement.parentElement.open",
            ),
            "Saving hours closes the form and restores focus",
        );
        await click("Start timer");
        await click("Pause timer");
        await until("window.__session.status === 'paused'");
        await click("Resume timer");
        await until("window.__session.status === 'running'");
        await click("Pause timer");
        await until("window.__session.status === 'paused'");
        await click("Settings");
        for (const theme of ["light", "moss", "dark"]) {
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
            assert(
                await evaluate(`document.documentElement.scrollWidth <= ${width}`),
                `Window at ${width}px must not overflow horizontally`,
            );
            await click("Add loot or expense Manual entry");
            assert(
                await evaluate(
                    `document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth`,
                ),
                "Entry dialog must fit compact windows",
            );
            if (width === 640) await screenshot("manual-entry-compact");
            await evaluate("document.querySelector('[aria-label=\"Close manual entry\"]').click()");
            for (const view of ["History", "Settings"]) {
                await click(view);
                assert(
                    await evaluate(`document.documentElement.scrollWidth <= ${width}`),
                    `${view} must fit at ${width}px`,
                );
                if (width === 640) await screenshot(`${view.toLowerCase()}-compact`);
            }
            await click("Grind desk");
        }
        assert.equal(errors.length, 0, JSON.stringify(errors));
        console.log(
            `UI smoke passed: timer, navigation, capture lifecycle, preview suppression, diagnostics, screenshot state, dialog focus, expense entry, ledger editing/filtering, history filters, themes, compact screens. Screenshots: ${output}`,
        );
    }
} finally {
    ws.close();
    await fetch(`http://127.0.0.1:9222/json/close/${page.id}`);
}
