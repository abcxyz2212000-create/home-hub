# Tesseract.js (bundled for OCR of receipts and transfer screens)

Served from this site so that no outside program runs; loaded only when 「画像から読む」 is pressed.
Images are read inside the browser and never sent anywhere.

| File | Source | License |
|---|---|---|
| tesseract.esm.min.js, worker.min.js | npm tesseract.js 7.0.0 (dist/) | Apache-2.0 (LICENSE-tesseract.js.md) |
| core/tesseract-core-*-lstm.wasm.js | npm tesseract.js-core 7.0.0 (LSTM builds only) | Apache-2.0 (core/LICENSE) |
| lang/jpn.traineddata.gz | npm @tesseract.js-data/jpn 1.0.0 (4.0.0_best_int) | package: MIT; data from tesseract-ocr/tessdata (Apache-2.0) |

To update: replace these files with the same names from the newer packages and bump the service worker cache.
