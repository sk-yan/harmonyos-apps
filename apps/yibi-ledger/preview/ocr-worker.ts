import { createWorker, PSM } from 'tesseract.js';

// Running Tesseract in an owned worker keeps initialization cancellable. Its
// nested engine worker and byte buffers disappear when the owner terminates.
const endpoint = self as unknown as {
  onmessage: ((event: MessageEvent<{ bytes: ArrayBuffer; base: string }>) => void) | null;
  postMessage(message: object): void;
};
endpoint.onmessage = async event => {
  const { bytes, base } = event.data;
  try {
    const worker = await createWorker(['chi_sim', 'eng'], 1, {
      workerPath: `${base}worker.min.js`, corePath: `${base}core/`, langPath: `${base}lang/`,
      workerBlobURL: false,
      logger: message => endpoint.postMessage({ type: 'progress', progress: message.status === 'recognizing text' ? message.progress : 0 }),
      errorHandler: error => endpoint.postMessage({ type: 'error', error: typeof error === 'string' ? error : '本地识别资源读取失败。' }),
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
    const result = await worker.recognize(new Blob([bytes]));
    await worker.terminate();
    endpoint.postMessage({ type: 'result', text: result.data.text });
  } catch (error) {
    endpoint.postMessage({ type: 'error', error: error instanceof Error ? error.message : '本地识别未完成。' });
  }
};
