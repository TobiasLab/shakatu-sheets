// Exercises the real installed webview and SQLite in an isolated user-data directory.
// WGC picker, game capture, DPI changes, and minimized OCR require the manual Windows protocol.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SESSION_AUTOSAVE_INTERVAL_MS } from "../src/hooks/sessionPersistence.ts";

const binary = process.env.DESKTOP_SMOKE_BINARY;
if (!binary) throw new Error("Set DESKTOP_SMOKE_BINARY to the installed application executable.");
const temporary = await mkdtemp(join(tmpdir(), "shakatu-desktop-"));
const local = join(temporary, "local");
const roaming = join(temporary, "roaming");
await Promise.all([mkdir(local), mkdir(roaming)]);
const driver = spawn(process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver", ["--port", "4445"], {
    env: {
        ...process.env,
        SHAKATU_DATA_DIR: roaming,
        WEBVIEW2_USER_DATA_FOLDER: local,
    },
    stdio: "inherit",
});
let driverFailure;
driver.on("error", (error) => {
    driverFailure = error;
});
const driverExited = new Promise((resolveExit) => driver.on("close", resolveExit));
const address = "http://127.0.0.1:4445";
let session;
async function request(path, body, method = "POST") {
    const response = await fetch(address + path, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value));
    return result.value;
}
const evaluate = (script) => request(`/session/${session}/execute/sync`, { script, args: [] });
async function waitFor(script) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluate(script)) return;
        await delay(100);
    }
    throw new Error(`Desktop condition timed out: ${script}`);
}
const button = (text) =>
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (driverFailure) throw driverFailure;
        try {
            await request("/status", undefined, "GET");
            break;
        } catch (error) {
            if (attempt === 99) throw error;
            await delay(100);
        }
    }
    const value = await request("/session", {
        capabilities: { alwaysMatch: { "tauri:options": { application: resolve(binary) } } },
    });
    session = value.sessionId;
    assert(session);
    await waitFor(`return Boolean(${button("Choose capture source")} && !${button("Choose capture source")}.disabled)`);
    assert((await stat(join(roaming, "shakatu-sheets.sqlite3"))).size > 0, "Smoke must use its isolated database");
    const assets = await request(`/session/${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1]; Promise.all(['worker.min.js','eng.traineddata.gz','tesseract-core-lstm.wasm.js'].map(async name => { const response = await fetch(new URL('ocr/' + name, document.baseURI)); return response.ok && (await response.arrayBuffer()).byteLength > 1000; })).then(done, error => done(String(error)));`,
        args: [],
    });
    assert.deepEqual(assets, [true, true, true]);
    for (const label of ["History", "Settings", "Grind desk"]) {
        // Navigation labels are resolved from the actual application, never a mocked Tauri response.
        const found = await evaluate(`const b = ${button(label)}; if (b) b.click(); return Boolean(b);`);
        assert(found, `Missing navigation: ${label}`);
    }
    assert(await evaluate(`const b = ${button("Add loot or expense")}; if (b) b.click(); return Boolean(b);`));
    await waitFor(
        "return Boolean(Array.from(document.querySelectorAll('button[type=submit]')).find(b => b.textContent.includes('Add to ledger')))",
    );
    await evaluate(
        "Array.from(document.querySelectorAll('button[type=submit]')).find(b => b.textContent.includes('Add to ledger')).click(); return true;",
    );
    let saved;
    const saveDeadline = Date.now() + SESSION_AUTOSAVE_INTERVAL_MS + 10_000;
    while (Date.now() < saveDeadline) {
        saved = await request(`/session/${session}/execute/async`, {
            script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('load_active_session').then(done, error => done({ error: String(error) }));",
            args: [],
        });
        if (saved?.entries?.length === 1) break;
        await delay(100);
    }
    assert.equal(saved?.entries?.length, 1, "The manual ledger entry must reach real SQLite");
    await request(`/session/${session}/refresh`, {});
    await waitFor(`return Boolean(${button("Choose capture source")} && !${button("Choose capture source")}.disabled)`);
    const restored = await request(`/session/${session}/execute/async`, {
        script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('load_active_session').then(done, error => done({ error: String(error) }));",
        args: [],
    });
    assert.deepEqual(restored?.entries, saved.entries, "Reload must preserve the saved ledger");
    await request(`/session/${session}/window/rect`, { width: 700, height: 500 });
    assert(
        await evaluate(
            "return [document.documentElement, document.getElementById('workspace')].every((e) => e.scrollWidth <= e.clientWidth + 1)",
        ),
    );
    await waitFor(`return Boolean(${button("Choose capture source")})`);
    console.info(
        "Installed desktop smoke passed: startup, local OCR assets, SQLite save/reload, navigation, and compact layout.",
    );
} finally {
    if (session) await request(`/session/${session}`, undefined, "DELETE").catch(() => undefined);
    driver.kill();
    await Promise.race([driverExited, delay(5_000)]);
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
