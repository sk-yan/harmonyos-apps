/** An owned outer worker makes cancellation cover OCR initialization as well. */
export class LocalOcr {
  private generation = 0;
  private worker: Worker | undefined;
  private rejectActive: ((error: Error) => void) | undefined;

  async recognize(file: File, progress: (fraction: number) => void): Promise<string> {
    this.cancel();
    const generation = this.generation;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 截图。');
    if (file.size > 8 * 1024 * 1024) throw new Error('截图超过 8 MB，请裁剪到单笔账单后重试。');
    const bitmap = await createImageBitmap(file);
    const pixels = bitmap.width * bitmap.height;
    bitmap.close();
    if (pixels > 16_000_000) throw new Error('截图分辨率过大，请裁剪到单笔账单后重试。');
    const bytes = await file.arrayBuffer();
    if (generation !== this.generation) throw new DOMException('已取消', 'AbortError');
    const worker = new Worker(new URL('./ocr-worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (text: string | undefined, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        if (this.worker === worker) { this.worker = undefined; this.rejectActive = undefined; }
        if (error) reject(error); else resolve(text ?? '');
      };
      const timeout = setTimeout(() => finish(undefined, new Error('识别超时。请裁剪截图，或粘贴图片中的文字。')), 90_000);
      this.rejectActive = error => finish(undefined, error);
      worker.onmessage = (event: MessageEvent<{ type: string; progress?: number; text?: string; error?: string }>) => {
        if (generation !== this.generation) return;
        if (event.data.type === 'progress') progress(event.data.progress ?? 0);
        if (event.data.type === 'result') finish(event.data.text);
        if (event.data.type === 'error') finish(undefined, new Error(event.data.error || '本地识别未完成。'));
      };
      worker.onerror = event => { event.preventDefault(); finish(undefined, new Error('本地识别资源加载失败，请重新打开页面后重试。')); };
      worker.postMessage({ bytes, base: new URL('./ocr-assets/', document.baseURI).href }, [bytes]);
    });
  }

  cancel(): void {
    this.generation += 1;
    this.rejectActive?.(new DOMException('已取消', 'AbortError'));
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectActive = undefined;
  }
}
