# OCR Assets

- `eng.traineddata.gz` is the English [`tessdata_best`](https://github.com/tesseract-ocr/tessdata_best) integer model,
  licensed under Apache-2.0. It was obtained from the npm package
  [`@tesseract.js-data/eng`](https://www.npmjs.com/package/@tesseract.js-data/eng), whose MIT label covers the
  packaging, not the model.
- `worker.min.js` is from [`tesseract.js`](https://github.com/naptha/tesseract.js), licensed under Apache-2.0.
- `tesseract-core-lstm.wasm.js`, `tesseract-core-simd-lstm.wasm.js`, and
  `tesseract-core-relaxedsimd-lstm.wasm.js` are from
  [`tesseract.js-core`](https://github.com/naptha/tesseract.js-core), licensed under Apache-2.0.
- The worker and cores come from `tesseract.js` 7.0.0 and its `tesseract.js-core` 7.0.0 dependency, the versions pinned
  in `package.json` and `package-lock.json`; they are byte-identical to `node_modules/tesseract.js/dist/worker.min.js`
  and the matching `node_modules/tesseract.js-core` files. Replace them together when upgrading `tesseract.js`.

These files are bundled so screenshot recognition remains local and the live-loot adapter can select the fastest LSTM
core supported by the current WebView without requiring network access.
