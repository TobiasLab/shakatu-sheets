import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const harness = `
import React,{useState} from 'react';
import ReactDOM from 'react-dom/client';
import {LootReview} from '/src/components/LiveLootCapture/LootReview.tsx';
import {LearningFeedback} from '/src/components/LearningFeedback/LearningFeedback.tsx';
import {SelfImprovementSettings} from '/src/views/Settings/SelfImprovementSettings.tsx';
import settingsStyles from '/src/views/Settings/Settings.module.css';
import {useSelfImprovement} from '/src/hooks/useSelfImprovement.ts';
import {correctLiveLootReviewEntry} from '/src/recognition/liveLootReview.ts';
import '/src/index.css';
const profile={font:'korean',uiScalePercent:80,sourceWidth:3440,sourceHeight:1440};
const rows=['.###.','#....','#....','####.','#...#','#...#','.###.'];
const pixels=new Uint8ClampedArray(9*11*4);
for(let y=0;y<7;y++)for(let x=0;x<5;x++)if(rows[y][x]==='#')pixels.fill(255,((y+2)*9+x+2)*4,((y+2)*9+x+2)*4+4);
const capturePixels=new Uint8ClampedArray(29*11*4);
for(let y=0;y<11;y++){const row=pixels.subarray(y*9*4,(y+1)*9*4);capturePixels.set(row,y*29*4);capturePixels.set(row,(y*29+9)*4);capturePixels.set(row,(y*29+20)*4);}
const evidence={frame:12,captureToken:123,batchId:456,roiWidth:362,roiHeight:311,quantityBounds:{left:120,top:50,right:129,bottom:61},itemBounds:{left:100,top:50,right:118,bottom:61},readings:['Black Stone x 9','Black Stone x &'],passes:[{threshold:150,scale:2,region:'line',text:'Black Stone x 9'}]};
function entry(id){return {id,source:'normal',font:'korean',learningProfile:profile,learningId:'event-'+id,learningContext:{sessionId:'session-1',generation:3},accepted:false,error:'',result:{eventId:'event-'+id,firstFrame:12,selectedFrames:[12],status:'withheld',reason:'consensus-withheld',itemName:null,quantity:null,capture:{width:29,height:11,pixels:capturePixels,quantityBounds:{left:20,top:0,right:29,bottom:11},itemBounds:{left:0,top:0,right:18,bottom:11},originalText:'Black Stone x 9',sourceFrame:evidence,ocrFrames:[evidence]}}};}
window.saved={enabled:false,autoAllow:false,examples:[]};window.added=[];window.failSave=false;
function Harness(){
 const learning=useSelfImprovement();const [reviews,setReviews]=useState([entry(1)]);
 window.addPending=(id,cropOverrides={})=>setReviews(current=>{const next=entry(id);Object.assign(next.result.capture,cropOverrides);return [...current,next];});
 window.reloadLearning=learning.reload;
 window.learningState=learning.state;
 function correct(id,item,quantity){const original=reviews.find(x=>x.id===id);const corrected=correctLiveLootReviewEntry(original,item,quantity,(item,quantity)=>{if(window.failAdd)return 'Synthetic ledger failure';window.added.push({item,quantity});return null;});setReviews(current=>current.map(x=>x.id===id?corrected:x));if(corrected.accepted&&!original.accepted)learning.learnCorrection(original,quantity,item);}
 return <main style={{maxWidth:900,margin:'20px auto',padding:16}}><h1 id="live-capture-heading" tabIndex={-1}>Learning test</h1>
 <LearningFeedback learning={learning}/>
 <LootReview controller={{reviewResults:reviews,omittedReviewResults:0,databaseLoaded:true,sessionStatus:'paused',itemDictionary:['Black Stone','Caphras Stone'],resultDescription:()=> 'Check quantity',clearReviewResults:()=>setReviews([]),dismissReviewResult:id=>setReviews(current=>current.filter(x=>x.id!==id)),correctReviewResult:correct,acceptReviewResult:()=>{},learning}}/>
 <div className={settingsStyles.Preferences}><SelfImprovementSettings learning={learning}/></div></main>;
}
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);`;
const mockApi = `export async function quantityLearning(operation){
 await new Promise(resolve=>setTimeout(resolve,30));
 if(operation.kind==='settings')Object.assign(window.saved,{enabled:operation.enabled,autoAllow:operation.enabled&&operation.autoAllow});
 if(operation.kind==='save'){
  if(window.failSave)throw Error('Synthetic storage failure');
  if(!window.saved.enabled)throw Error('Learning is off');
  window.saved.examples.unshift({...operation.example,confirmedAt:Date.now(),validation:false});
 }
 if(operation.kind==='delete')window.saved.examples=window.saved.examples.filter(x=>x.id!==operation.id);
 if(operation.kind==='reset')window.saved={enabled:false,autoAllow:false,examples:[]};
 return structuredClone(window.saved);
}`;
const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    plugins: [
        {
            name: "learning-fixture",
            enforce: "pre",
            transform(_code, id) {
                if (id.endsWith("/src/main.tsx")) return harness;
                if (id.endsWith("/src/api/quantityLearning.ts")) return mockApi;
                if (id.endsWith("/src/api/tauri.ts")) return "export const supportsTauriApi=()=>true;";
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
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    message.error ? request.reject(message.error) : request.resolve(message.result);
});
const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function until(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw Error(`Timeout: ${expression}\n${await evaluate("document.body.innerText")}`);
}
async function button(label) {
    await evaluate(
        `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw Error('Missing enabled button: '+${JSON.stringify(label)});button.click();})()`,
    );
}
async function field(selector, value) {
    await evaluate(
        `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
}
async function correct(quantity) {
    await field("#loot-review-detail select", "Black Stone");
    await field('#loot-review-detail input[type="number"]', String(quantity));
    await button("Add to session");
}
try {
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await server.listen();
    await send("Page.navigate", { url: server.resolvedUrls.local[0] });
    await until(`document.querySelector('input[type=checkbox]')?.disabled===false`);
    await evaluate("document.querySelector('#self-improvement-examples').open=true");
    assert.equal(await evaluate("window.learningState.enabled"), false);
    assert.equal(await evaluate("document.querySelectorAll('input[type=checkbox]')[1].disabled"), true);
    await correct(6);
    assert.equal(await evaluate("window.saved.examples.length"), 0, "Disabled learning saves no crop");
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await until("window.learningState.enabled===true");
    await evaluate("window.addPending(2);window.failAdd=true");
    await until("!!document.querySelector('#review-select-2')");
    await correct(6);
    assert.equal(await evaluate("window.saved.examples.length"), 0, "Failed ledger insert does not teach");
    await evaluate("window.failAdd=false");
    await button("Add to session");
    await until("window.saved.examples.length===1");
    await until(
        "document.querySelector('.sr-only[aria-live=polite]')?.textContent==='Correction saved for self-improvement.'",
    );
    assert.equal(
        await evaluate("document.querySelectorAll('[data-tone]').length"),
        0,
        "A saved correction is announced without a lasting banner",
    );
    assert.equal(await evaluate("window.saved.examples[0].quantity"), 6);
    assert.equal(await evaluate("window.saved.examples[0].itemName"), "Black Stone");
    assert.equal(await evaluate("window.saved.examples[0].itemImage.width"), 18);
    await evaluate(
        "[...document.querySelectorAll('summary')].find(el=>el.textContent.startsWith('Automatic recovery checks')).parentElement.open=true",
    );
    assert.deepEqual(
        await evaluate(
            "[...[...document.querySelectorAll('#self-improvement table')].find(t=>t.caption.textContent.startsWith('Items')).tBodies[0].rows].map(row=>[...row.children].map(cell=>cell.textContent))",
        ),
        [["Black Stone", "1", "0/0", "0", "Not ready"]],
        "Recovery checks list each learned item with its evidence",
    );
    assert.equal(
        await evaluate(
            "[...document.querySelectorAll('#self-improvement caption')].some(c=>c.textContent==='Items · Korean · 80% · 3440 × 1440')",
        ),
        true,
    );
    assert.equal(await evaluate("window.saved.examples[0].audit.cropFrame.frame"), 12);
    assert.equal(await evaluate("window.saved.examples[0].audit.sessionId"), "session-1");
    assert.equal(await evaluate("window.saved.examples[0].audit.frames[0].passes[0].text"), "Black Stone x 9");
    await until("!!document.querySelector('details details')");
    await evaluate("document.querySelector('details details').open=true");
    assert(await evaluate("document.body.innerText.includes('Frame 12 · Saved quantity image')"));
    assert(await evaluate("document.body.innerText.includes('Black Stone x 9')"));
    assert(await evaluate("document.body.innerText.includes('Black Stone × 6')"));
    const before = await evaluate("window.added.length");
    const savedBefore = await evaluate("window.saved.examples.length");
    await evaluate("window.addPending(3)");
    await until("document.querySelector('#loot-review-detail input[type=number]')?.value==='6'");
    if (process.env.UI_SMOKE_OUTPUT) {
        await mkdir(process.env.UI_SMOKE_OUTPUT, { recursive: true });
        const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        await writeFile(`${process.env.UI_SMOKE_OUTPUT}/learning-review.png`, Buffer.from(data, "base64"));
    }
    await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
    assert(
        await evaluate("document.documentElement.scrollWidth<=innerWidth"),
        "Item evidence and saved images fit narrow windows",
    );
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate("document.querySelector('#loot-review-detail select').value"), "Black Stone");
    assert.equal(await evaluate("window.added.length"), before, "Suggestion does not insert loot");
    assert.equal(await evaluate("document.querySelector('#loot-review-detail input[type=number]').value"), "6");
    assert.equal(await evaluate("window.saved.examples.length"), savedBefore, "Prefill does not teach");
    for (const [entryId, overrides, expectedItem, expectedQuantity] of [
        [30, { itemBounds: null }, "", "6"],
        [31, { quantityBounds: null }, "Black Stone", "1"],
        [32, { itemBounds: null, quantityBounds: null }, "", "1"],
    ]) {
        await evaluate(`window.addPending(${entryId},${JSON.stringify(overrides)})`);
        await until(`!!document.querySelector('#review-select-${entryId}')`);
        await evaluate(`document.querySelector('#review-select-${entryId}').click()`);
        assert.equal(await evaluate("document.querySelector('#loot-review-detail select').value"), expectedItem);
        assert.equal(
            await evaluate("document.querySelector('#loot-review-detail input[type=number]').value"),
            expectedQuantity,
        );
        await evaluate(`document.querySelector('[aria-label="Dismiss review entry ${entryId + 1}"]').click()`);
    }
    await evaluate("window.addPending(33)");
    await until("!!document.querySelector('#review-select-33')");
    await evaluate("document.querySelector('#review-select-33').click()");
    await field("#loot-review-detail select", "Caphras Stone");
    await field('#loot-review-detail input[type="number"]', "7");
    // A changed library must preserve both the untouched prefill and the manually edited draft.
    await evaluate(
        "window.saved.examples[0].quantity=9;window.saved.examples[0].itemName='Caphras Stone';window.reloadLearning()",
    );
    await evaluate("document.querySelector('#review-select-3').click()");
    assert.equal(await evaluate("document.querySelector('#loot-review-detail select').value"), "Black Stone");
    assert.equal(await evaluate("document.querySelector('#loot-review-detail input[type=number]').value"), "6");
    const suggestedFields =
        "[...document.querySelectorAll('#loot-review-detail label > span')].filter(el=>el.textContent.includes('Suggested')).length";
    assert.equal(
        await evaluate(suggestedFields),
        2,
        "Both prefilled fields stay marked as suggested when the library changes",
    );
    assert(
        !(await evaluate("document.querySelector('#loot-review-detail').textContent.includes('Caphras Stone × 9')")),
        "The suggestion note must not show an unapplied replacement",
    );
    await evaluate("document.querySelector('#review-select-33').click()");
    assert.equal(await evaluate(suggestedFields), 0, "Manually edited fields are not marked as suggested");
    assert.equal(await evaluate("document.querySelector('#loot-review-detail select').value"), "Caphras Stone");
    assert.equal(await evaluate("document.querySelector('#loot-review-detail input[type=number]').value"), "7");
    await evaluate("document.querySelector('[aria-label=\"Dismiss review entry 34\"]').click()");
    assert.equal(await evaluate("window.added.length"), before, "Prefill and edits require explicit confirmation");
    assert.equal(await evaluate("window.saved.examples.length"), savedBefore, "Prefill and edits do not teach");
    await evaluate(
        "window.saved.examples[0].quantity=6;window.saved.examples[0].itemName='Black Stone';window.reloadLearning()",
    );
    await evaluate("window.failSave=true");
    await button("Add to session");
    const notice = "document.querySelector('[class*=Notices]')";
    await until(`${notice}?.textContent.includes('(Synthetic storage failure)')`);
    assert.equal(
        await evaluate(`${notice}.querySelectorAll('[data-tone]').length`),
        1,
        "A save failure stays with its unsaved example instead of a separate error",
    );
    assert.equal(
        await evaluate("document.querySelectorAll('[class*=Notices]').length"),
        2,
        "The capture strip and Settings both offer the unsaved example",
    );
    assert.equal(await evaluate("window.added.length"), before + 1, "Storage failure does not undo the drop");
    assert.deepEqual(
        await evaluate("window.added.at(-1)"),
        { item: "Black Stone", quantity: 6 },
        "One Add click confirms both prefilled fields",
    );
    await evaluate("window.failSave=false;window.addPending(4)");
    await until("!!document.querySelector('#review-select-4')");
    await correct(6);
    await until("window.saved.examples.length===2");
    assert.equal(
        await evaluate(`${notice}?.querySelector('p').textContent`),
        "A learning example could not be saved. Your drop was added. Retry before closing the app.",
        "A later save must not discard a previous failed example",
    );
    assert(
        !(await evaluate("document.querySelector('#self-improvement [data-tone=success]')")),
        "Settings must not report a saved correction beside an unsaved one",
    );
    await button("Retry save");
    await until("window.saved.examples.length===3");
    assert.equal(await evaluate("window.added.length"), before + 2, "Retry only saves the example");
    await until(`!${notice}`);
    assert.equal(
        await evaluate("document.querySelector('#self-improvement .sr-only[aria-live=polite]').textContent"),
        "Correction saved for self-improvement.",
        "A retry is announced from Settings too",
    );
    await evaluate("window.failSave=true;window.addPending(5)");
    await until("!!document.querySelector('#review-select-5')");
    await correct(8);
    await until(`!!${notice}`);
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await until("window.learningState.enabled===false");
    assert(await evaluate(`${notice}.querySelector('p').textContent.endsWith('Turn self-improvement on to retry.')`));
    assert(
        !(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Retry save')")),
        "Retry is replaced while learning is off",
    );
    await evaluate("document.querySelector('input[type=checkbox]').click()");
    await until("window.learningState.enabled===true");
    await button("Discard");
    assert.equal(await evaluate(notice), null, "Discard clears the notice");
    assert.equal(await evaluate("window.saved.examples.length"), 3, "Discard does not save the example");
    await evaluate("window.failSave=false");
    await evaluate("document.querySelectorAll('input[type=checkbox]')[1].click()");
    await until("window.learningState.autoAllow===true");
    await until(
        "[...document.querySelectorAll('summary')].some(el=>el.textContent==='Automatic recovery checks 0 ready')",
    );
    await button("Delete");
    await until("window.saved.examples.length===2");
    await button("Reset self-improvement");
    await button("Keep examples");
    assert.equal(await evaluate("window.saved.examples.length"), 2);
    await button("Reset self-improvement");
    await button("Delete all examples");
    await until(
        "window.learningState.examples.length===0&&!window.learningState.enabled&&!window.learningState.autoAllow",
    );
    await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"), "Learning controls fit narrow windows");
    assert.deepEqual(errors, []);
    console.info(
        "Learning opt-in, corrections, audit provenance, suggestions, failure retry, auto toggle, deletion and reset passed",
    );
} finally {
    ws.close();
    await Promise.allSettled([fetch(`http://127.0.0.1:9222/json/close/${page.id}`), server.close()]);
}
