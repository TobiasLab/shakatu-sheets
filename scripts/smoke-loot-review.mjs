// Run with Chromium listening on port 9222. Uses real review components and synthetic local captures.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const harness = `import React, {useRef,useState} from 'react';
import ReactDOM from 'react-dom/client';
import {LootReview} from './components/LiveLootCapture/LootReview';
import {FinishReviewDialog} from './views/LiveSession/FinishReviewDialog';
import {correctLiveLootReviewEntry,acceptLiveLootReviewEntry} from './recognition/liveLootReview';
import './index.css';
function entries(){
 const canvas=document.createElement('canvas');canvas.width=360;canvas.height=48;
 const context=canvas.getContext('2d');context.fillStyle='#19181e';context.fillRect(0,0,360,48);
 context.fillStyle='#f3ead4';context.font='20px sans-serif';context.fillText('Black Stone × 3',16,30);
 const capture={width:360,height:48,pixels:context.getImageData(0,0,360,48).data};
 return [
  {id:10,source:'normal',accepted:false,error:'',result:{status:'withheld',reason:'quantity-not-recognized',itemName:null,quantity:null,capture}},
  {id:11,source:'rare',accepted:false,error:'',result:{status:'withheld',reason:'item-not-recognized',itemName:null,quantity:null,capture}},
  {id:12,source:'normal',accepted:false,error:'No valid price is available. Fetch prices in Settings → Market.',result:{status:'recognized',reason:null,itemName:'Ancient Spirit Dust',quantity:2}},
  {id:13,source:'normal',accepted:false,error:'',result:{status:'failed',reason:'ocr-failure',itemName:null,quantity:null}},
  {id:14,source:'normal',accepted:false,error:'',result:{status:'dropped',reason:'backpressure-summary',count:4,itemName:null,quantity:null}}
 ];
}
function Harness(){
 const [reviews,setReviews]=useState(entries);
 const [preparing,setPreparing]=useState(false),[error,setError]=useState('');
 const dialog=useRef(null);
 const accept=(item,quantity)=>{if(window.failAdd)return 'Synthetic price unavailable';window.added.push({item,quantity});return null;};
 window.added ??=[];window.reviews=reviews;
 window.reset=()=>{setReviews(entries());window.added=[];};
 window.prepend=()=>setReviews(current=>[{...entries()[0],id:99},...current]);
 window.setDialogState=(state)=>{setPreparing(state==='preparing');setError(state==='error'?'Synthetic capture failure: '+ 'x'.repeat(240):'');};
 window.resolveFirst=()=>setReviews(current=>current.map(entry=>entry.id===10?{...entry,accepted:true}:entry));
 const keep=()=>dialog.current.close();
 return <main style={{maxWidth:1100,margin:'0 auto',padding:24}}>
  <header className='topbar'><h2 id='live-capture-heading' tabIndex={-1}>Loot capture</h2>
   <button className='button' id='finish-fixture' onClick={()=>dialog.current.showModal()}>Finish</button></header>
  <LootReview controller={{reviewResults:reviews,omittedReviewResults:0,databaseLoaded:true,sessionStatus:'paused',
   itemDictionary:['Black Stone','Ancient Spirit Dust','Caphras Stone'],
   resultDescription:result=>result.status==='dropped'?'Recognition capacity was full.':result.status==='failed'?'The notification could not be read.':'The item or quantity could not be confirmed.',
   clearReviewResults:()=>setReviews([]),dismissReviewResult:id=>setReviews(current=>current.filter(entry=>entry.id!==id)),
   correctReviewResult:(id,item,quantity)=>{
    const entry=reviews.find(entry=>entry.id===id);
    if(!entry)return;
    const corrected=correctLiveLootReviewEntry(entry,item,quantity,accept);
    setReviews(current=>current.map(entry=>entry.id===id?corrected:entry));
   },
   acceptReviewResult:id=>{
    const entry=reviews.find(entry=>entry.id===id);
    if(!entry)return;
    const accepted=acceptLiveLootReviewEntry(entry,accept);
    setReviews(current=>current.map(entry=>entry.id===id?accepted:entry));
   }
  }}/>
  <FinishReviewDialog dialogRef={dialog} preparing={preparing} error={error} unresolvedCount={reviews.filter(entry=>!entry.accepted).length} canFinish={true}
   onKeepOpen={keep} onReview={()=>{keep();document.getElementById('loot-review-heading')?.focus();}}
   onFinish={()=>{window.finished=true;keep();}}/>
 </main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);`;
const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [
        {
            name: "review-fixture",
            enforce: "pre",
            transform(_code, id) {
                if (id.endsWith("/src/main.tsx")) return harness;
                if (id.endsWith("/src/recognition/retryLootCapture.ts"))
                    return `export async function retryLootCapture(capture,source,items,signal){await new Promise(r=>setTimeout(r,window.retryDelay??30));if(signal.aborted){window.retryAborted=true;signal.throwIfAborted();}if(window.failRetry)throw Error('Synthetic OCR failure');return {item:'Black Stone',quantity:3};}`;
            },
        },
        react(),
    ],
    server: { host: "127.0.0.1", port: 0 },
});
const page = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params);
    if (!m.id) return;
    const request = pending.get(m.id);
    pending.delete(m.id);
    m.error ? request.reject(m.error) : request.resolve(m.result);
});
const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression) {
    for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
    }
    throw Error(
        `Timeout: ${expression}\n${JSON.stringify(await evaluate('({text:document.body.innerText,added:window.added,selected:document.querySelector("[data-review-entry] [aria-pressed=true]")?.id,focus:document.activeElement.id})'))}`,
    );
}
async function click(selector) {
    const point = await evaluate(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Missing enabled control');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await delay(60);
}
async function button(label) {
    const selector = await evaluate(
        `(()=>{const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!el)throw Error('Missing button');el.id='fixture-action';return '#fixture-action';})()`,
    );
    await click(selector);
    await evaluate(`document.querySelector('#fixture-action')?.removeAttribute('id')`);
}
async function field(selector, value) {
    await evaluate(
        `(()=>{const el=document.querySelector('${selector}');Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
}
async function screenshot(name) {
    if (!process.env.UI_SMOKE_OUTPUT) return;
    await mkdir(process.env.UI_SMOKE_OUTPUT, { recursive: true });
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(`${process.env.UI_SMOKE_OUTPUT}/${name}.png`, Buffer.from(data, "base64"));
}
async function viewport(width, height) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
}
try {
    await send("Page.enable");
    await send("Runtime.enable");
    await server.listen();
    await viewport(1280, 800);
    await send("Page.navigate", { url: server.resolvedUrls.local[0] });
    await send("Page.bringToFront");
    await until(`document.querySelectorAll('[data-review-entry]').length===5`);
    assert.equal(await evaluate(`document.querySelectorAll('#loot-review-detail form').length`), 1);
    for (const theme of ["dark", "light", "moss"]) {
        await evaluate(`document.documentElement.dataset.theme='${theme}'`);
        await viewport(1280, 800);
        await screenshot(`review-${theme}`);
        await click("#finish-fixture");
        await screenshot(`finish-${theme}`);
        for (const width of [640, 320]) {
            await viewport(width, 420);
            await screenshot(`finish-${width}-${theme}`);
            assert(
                await evaluate(
                    `(()=>{const d=document.querySelector('dialog[open]'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth&&[...d.querySelectorAll('button')].every(b=>{const q=b.getBoundingClientRect();return q.top>=r.top&&q.bottom<=r.bottom;});})()`,
                ),
                "Finish controls fit short windows",
            );
        }
        await button("Review drops");
        assert.equal(await evaluate("document.activeElement.id"), "loot-review-heading");
        await viewport(640, 420);
        await screenshot(`review-640-${theme}`);
        assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"));
    }
    await viewport(1280, 800);
    await evaluate(`document.documentElement.dataset.theme='dark'`);
    await field("#loot-review-detail select", "Caphras Stone");
    await field("#loot-review-detail input", "7");
    await click("#review-select-10");
    for (const [key, code, expected] of [
        ["ArrowDown", 40, "11"],
        ["ArrowUp", 38, "10"],
        ["End", 35, "14"],
        ["Home", 36, "10"],
    ]) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
        await until(`document.activeElement.id==='review-select-${expected}'`);
    }
    assert.equal(await evaluate(`document.querySelectorAll('[data-review-entry] button[tabindex="0"]').length`), 1);
    assert.equal(await evaluate(`document.querySelector('#loot-review-detail select').value`), "Caphras Stone");
    assert.equal(await evaluate(`document.querySelector('#loot-review-detail input').value`), "7");
    await evaluate("window.prepend()");
    await until(`document.querySelector('#review-select-10').getAttribute('aria-pressed')==='true'`);
    await button("Add to session");
    await until(`document.querySelector('#review-select-11').getAttribute('aria-pressed')==='true'`);
    assert.equal(await evaluate("document.activeElement.id"), "review-select-11");
    assert.deepEqual(await evaluate("window.added"), [{ item: "Caphras Stone", quantity: 7 }]);
    await evaluate("window.retryDelay=300");
    await button("Retry OCR");
    await click("#review-select-99");
    await until("window.retryAborted===true");
    assert.equal(await evaluate("window.added.length"), 1);
    await evaluate("window.retryDelay=30");
    await button("Retry OCR");
    await until(`document.body.textContent.includes('Use suggestion')`);
    await button("Use suggestion");
    assert.equal(await evaluate("window.added.length"), 1);
    assert.equal(await evaluate(`document.querySelector('#loot-review-detail input').value`), "3");
    await evaluate("window.failAdd=true");
    await button("Add to session");
    await until(`document.querySelector('#loot-review-detail [role=alert]')?.textContent.includes('Synthetic price')`);
    await screenshot("review-add-error");
    await evaluate("window.failAdd=false");
    await button("Add to session");
    await until(`!document.querySelector('[data-review-entry="99"]')`);
    await click("#review-select-12");
    assert.equal(await evaluate(`document.querySelectorAll('#loot-review-detail form').length`), 0);
    await button("Retry add");
    await until(`!document.querySelector('[data-review-entry="12"]')`);
    await click("#review-select-14");
    assert.equal(await evaluate(`document.querySelectorAll('#loot-review-detail form').length`), 0);
    await screenshot("review-dropped");
    await button("Dismiss");
    await click("#review-select-13");
    await screenshot("review-no-image");
    await button("Dismiss");
    await evaluate("window.failRetry=true");
    await button("Retry OCR");
    await until(
        `document.querySelector('#loot-review-detail [role=status]')?.textContent.includes('Synthetic OCR failure')`,
    );
    await screenshot("review-retry-error");
    await button("Dismiss all");
    await screenshot("review-dismiss-all");
    await button("Keep captures");
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Dismiss all");
    assert(await evaluate(`!!document.querySelector('#review-select-11')`));
    await button("Dismiss all");
    await button("Discard captures");
    await until(`!document.querySelector('#loot-review-heading')`);
    assert.equal(await evaluate("document.activeElement.id"), "live-capture-heading");
    await evaluate("window.reset()");
    await until(`!!document.querySelector('#review-select-10')`);
    assert.equal(await evaluate(`document.querySelector('#loot-review-detail select').value`), "");
    await click("#review-select-10");
    await evaluate('document.querySelector("#finish-fixture").focus();window.resolveFirst()');
    await until(`!document.querySelector('#review-select-10')`);
    assert.equal(
        await evaluate("document.activeElement.id"),
        "finish-fixture",
        "Background resolutions must not steal focus",
    );
    await evaluate("window.reset()");
    for (const state of ["preparing", "error"]) {
        await evaluate(`window.setDialogState('${state}')`);
        await viewport(640, 420);
        await click("#finish-fixture");
        await screenshot(`finish-${state}`);
        assert.equal(
            await evaluate(
                `[...document.querySelectorAll('dialog[open] button')].some(b=>b.textContent==='Finish without adding these drops')`,
            ),
            false,
        );
        await send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
        });
        await send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
        });
        await until(`!document.querySelector('dialog[open]')`);
        assert.equal(await evaluate("document.activeElement.id"), "finish-fixture");
    }
    assert.deepEqual(errors, []);
    console.info("Review queue, drafts, advancement, retries, errors, dismissal, and responsive finish dialog passed");
} finally {
    ws.close();
    await Promise.allSettled([fetch(`http://127.0.0.1:9222/json/close/${page.id}`), server.close()]);
}
