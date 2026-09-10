# Local OCR notices

The browser build includes these unmodified, pinned components. Their assets are
served from the same origin under `ocr-assets/`; recognition does not call a CDN
or send the selected image to any server.

- Tesseract.js 7.0.0: Apache-2.0. Source: https://github.com/naptha/tesseract.js
  The full license is included as `licenses/tesseract.js.txt`; bundled worker
  notices are retained beside `worker.min.js`.
- Tesseract.js-core 7.0.0: Apache-2.0. Source:
  https://github.com/naptha/tesseract.js-core
  The full upstream license is included as `licenses/tesseract-core.txt`.
- Simplified Chinese and English `4.0.0_best_int` trained language data from
  `@tesseract.js-data/chi_sim` and `@tesseract.js-data/eng` 1.0.0. The language data
  repository is Apache-2.0: https://github.com/naptha/tessdata. It derives from
  https://github.com/tesseract-ocr/tessdata_best. The Apache-2.0 text is included
  in `licenses/tesseract-core.txt`. The npm package metadata declares MIT for
  its packaging and is retained in `licenses/chi_sim-package.json` and
  `licenses/eng-package.json`.

No language models are modified or retrained here. Recognition is an editable
draft, not a verified transaction. Clipped images, small text, multiple amounts,
and missing dates or directions require user review.
