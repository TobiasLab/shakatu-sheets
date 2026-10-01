import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = process.argv[2] ?? process.env.MARNI_BENCHMARK_DIR;
if (!datasetPath) throw new Error("Pass a dataset directory or set MARNI_BENCHMARK_DIR.");
const dataset = resolve(datasetPath);
const examples = JSON.parse(await readFile(join(dataset, "manifest.json"), "utf8"));
const runDirectory = await mkdtemp(join(tmpdir(), "shakatu-sheets-benchmark-"));
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1422"], {
    cwd: root,
    stdio: "ignore",
});
const browser = spawn(
    process.env.CHROMIUM ??
        (process.platform === "win32"
            ? `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`
            : "/usr/bin/chromium"),
    [
        "--headless=new",
        "--no-sandbox",
        "--remote-debugging-port=9342",
        `--user-data-dir=${join(runDirectory, "profile")}`,
        "about:blank",
    ],
    { env: { ...process.env, TMPDIR: runDirectory }, stdio: "ignore" },
);

async function stop(child) {
    if (child.exitCode !== null) return;
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
    if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
    }
}

let socket;
try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            if ((await fetch("http://127.0.0.1:1422")).ok) break;
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }

    let target;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const targets = await fetch("http://127.0.0.1:9342/json").then((response) => response.json());
            target = targets.find((candidate) => candidate.type === "page");
            if (target) break;
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!target) throw new Error("Chromium did not start.");

    socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let requestId = 0;
    socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        request(message.result);
    };
    await new Promise((resolveOpen) => {
        socket.onopen = resolveOpen;
    });

    function send(method, params = {}) {
        requestId += 1;
        socket.send(JSON.stringify({ id: requestId, method, params }));
        return new Promise((resolveRequest) => pending.set(requestId, resolveRequest));
    }

    async function evaluate(expression) {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        return result.result.value;
    }

    await send("Page.enable");
    await send("Runtime.enable");
    await send("DOM.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
            if(command==="load_active_session")return null;
            if(command==="load_market_prices")return[];
            if(command==="save_session")window.__savedSession=args.session;
            return null;
        }};`,
    });
    await send("Page.navigate", { url: "http://127.0.0.1:1422" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));

    async function recognize(file) {
        const document = await send("DOM.getDocument");
        const input = await send("DOM.querySelector", { nodeId: document.root.nodeId, selector: 'input[type="file"]' });
        await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [join(dataset, file)] });
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        for (let attempt = 0; attempt < 180; attempt += 1) {
            const state = await evaluate(`(() => ({
                rows: document.querySelectorAll('img[alt^="Screenshot loot slot"]').length,
                error: [...document.querySelectorAll('p')].find((node) => node.textContent?.includes('Could not'))?.textContent || ''
            }))()`);
            if (state.error) throw new Error(`${file}: ${state.error}`);
            if (state.rows > 0) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        }
        const result = await evaluate(`(() => {
            const profileSelects = [...document.querySelectorAll('select')].filter((select) =>
                [...select.options].some((option) => option.value === 'sycraia-lower-revamp')
            );
            return {
                duration: [...document.querySelectorAll('input')].find((input) => input.placeholder === '01:00:00')?.value,
                spot: profileSelects.at(-1)?.value,
                quantities: [...document.querySelectorAll('img[alt^="Screenshot loot slot"]')].map((image) =>
                    image.parentElement.querySelector('input').value
                )
            };
        })()`);
        await evaluate(
            `[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel')?.click()`,
        );
        return result;
    }

    const failures = [];
    let correctQuantities = 0;
    let totalQuantities = 0;
    let correctMetadata = 0;
    for (const example of examples) {
        let actual;
        try {
            actual = await recognize(example.file);
        } catch (error) {
            failures.push(String(error));
            totalQuantities += example.quantities.length;
            continue;
        }
        for (const field of ["spot", "duration"]) {
            if (actual[field] === example[field]) correctMetadata += 1;
            else failures.push(`${example.file} ${field}: expected ${example[field]}, got ${actual[field] || "blank"}`);
        }
        totalQuantities += example.quantities.length;
        if (actual.quantities.length !== example.quantities.length) {
            failures.push(
                `${example.file} slots: expected ${example.quantities.length}, got ${actual.quantities.length}`,
            );
        }
        for (let index = 0; index < example.quantities.length; index += 1) {
            if (actual.quantities[index] === example.quantities[index]) correctQuantities += 1;
            else {
                failures.push(
                    `${example.file} slot ${index + 1}: expected ${example.quantities[index]}, got ${actual.quantities[index] || "blank"}`,
                );
            }
        }
    }

    const labeled = new Set(examples.map(({ file }) => file));
    const unlabeled = (await readdir(dataset)).filter(
        (file) => /\.(png|jpe?g|webp)$/i.test(file) && !labeled.has(file),
    );
    console.log(`Metadata: ${correctMetadata}/${examples.length * 2}`);
    console.log(`Quantities: ${correctQuantities}/${totalQuantities}`);
    if (failures.length > 0) console.log(`\nMismatches:\n${failures.join("\n")}`);
    if (unlabeled.length > 0) console.log(`\nUnlabeled images:\n${unlabeled.join("\n")}`);
} finally {
    socket?.close();
    await Promise.all([stop(browser), stop(server)]);
    await rm(runDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
