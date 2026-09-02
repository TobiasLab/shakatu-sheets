# OCR Assets

- `eng.traineddata.gz` is the English `tessdata_best` integer model from
  [`@tesseract.js-data/eng`](https://www.npmjs.com/package/@tesseract.js-data/eng), licensed under MIT.
- `worker.min.js` is from [`tesseract.js`](https://github.com/naptha/tesseract.js), licensed under Apache-2.0.
- `tesseract-core-lstm.wasm.js`, `tesseract-core-simd-lstm.wasm.js`, and
  `tesseract-core-relaxedsimd-lstm.wasm.js` are from
  [`tesseract.js-core`](https://github.com/naptha/tesseract.js-core), licensed under Apache-2.0.

These files are bundled so screenshot recognition remains local and the live-loot adapter can select the fastest LSTM
core supported by the current WebView without requiring network access.
