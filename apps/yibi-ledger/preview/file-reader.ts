import { parseCsv } from '../entry/src/main/ets/model/BillImport';
import { readXlsxRows } from '../entry/src/main/ets/model/Spreadsheet';

export interface BillFile { name: string; format: 'CSV' | 'XLSX'; rows: string[][] }
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function readBillFile(file: File, cancelled: () => boolean): Promise<BillFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 8 MB，请缩小导出日期范围后再试。');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension !== 'csv' && extension !== 'xlsx') throw new Error('请选择 CSV 或 XLSX 账单。压缩包需要先解压，加密文件需要先解密。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (cancelled()) throw new DOMException('已取消', 'AbortError');
  if (extension === 'csv') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    return { name: file.name, format: 'CSV', rows: parseCsv(text) };
  }
  const rows = await readXlsxRows(bytes, async (compressed, maxOutputBytes) => {
    const stream = new Blob([new Uint8Array(compressed).buffer]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        if (cancelled()) throw new DOMException('已取消', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxOutputBytes) throw new Error('XLSX 解压后超过安全大小，请缩小导出范围。');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  });
  if (cancelled()) throw new DOMException('已取消', 'AbortError');
  return { name: file.name, format: 'XLSX', rows };
}
