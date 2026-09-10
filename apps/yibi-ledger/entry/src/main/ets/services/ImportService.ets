import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { BusinessError, zlib } from '@kit.BasicServicesKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { image } from '@kit.ImageKit';
import { textRecognition } from '@kit.CoreVisionKit';
import { parseCsv } from '../model/BillImport';
import { decodeSpreadsheetUtf8, readXlsxRows } from '../model/Spreadsheet';

const MAX_FILE_BYTES: number = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS: number = 24 * 1024 * 1024;
let recognizing: boolean = false;

export interface BillFile {
  name: string;
  format: string;
  rows: string[][];
}

interface SelectedBytes {
  name: string;
  bytes: Uint8Array;
}

/** Reads only a user-selected URI; the URI is never retained or sent elsewhere. */
async function readSelected(uri: string): Promise<SelectedBytes> {
  const file = await fs.open(uri, fs.OpenMode.READ_ONLY);
  try {
    const info = await fs.stat(file.fd);
    if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 8 MiB，请缩短账单日期范围或裁剪截图。');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      // One extra byte detects a growing file or a provider with an inaccurate stat size.
      const buffer = new ArrayBuffer(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total));
      // fs.read without offset advances from the descriptor's current position (SDK FileIO contract).
      const count = await fs.read(file.fd, buffer);
      if (count === 0) break;
      if (count < 0 || count > buffer.byteLength) throw new Error('文件读取不完整，请重新选择。');
      total += count;
      if (total > MAX_FILE_BYTES) throw new Error('文件超过 8 MiB，请缩短账单日期范围或裁剪截图。');
      chunks.push(new Uint8Array(buffer.slice(0, count)));
    }
    if (total === 0) throw new Error('所选文件为空，请重新导出或选择其他文件。');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let name = '';
    try {
      name = file.name;
    } catch (error) {
      // Some picker providers expose readable bytes without a resolvable File.name.
      const cleanUri = uri.split('?')[0];
      const parts = cleanUri.split('/');
      try {
        name = decodeURIComponent(parts[parts.length - 1]);
      } catch (decodingError) {
        name = parts[parts.length - 1];
      }
    }
    return { name, bytes };
  } finally {
    await fs.close(file);
  }
}

function decodeCsv(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return util.TextDecoder.create('utf-16le', { fatal: true }).decodeToString(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return util.TextDecoder.create('utf-16be', { fatal: true }).decodeToString(bytes);
  }
  try {
    return decodeSpreadsheetUtf8(bytes);
  } catch (error) {
    // Alipay exports may use GBK; GB18030 is its backwards-compatible superset.
    return util.TextDecoder.create('gb18030', { fatal: true }).decodeToString(bytes);
  }
}

async function inflateSpreadsheet(data: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  if (maxOutputBytes < 0 || maxOutputBytes > 16 * 1024 * 1024) throw new Error('表格展开内容过大。');
  const zip = await zlib.createZip();
  const stream: zlib.ZStream = {
    nextIn: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    availableIn: data.byteLength,
    totalIn: 0,
    nextOut: new ArrayBuffer(maxOutputBytes + 1),
    availableOut: maxOutputBytes + 1,
    totalOut: 0
  };
  let initialized = false;
  try {
    const initialization = await zip.inflateInit2(stream, -15);
    if (initialization !== zlib.ReturnStatus.OK) throw new Error('无法初始化表格解压。');
    initialized = true;
    const status = await zip.inflate(stream, zlib.CompressFlushMode.FINISH);
    // Native zlib owns the counters; it writes bytes into nextOut but does not
    // mutate the input object's totalIn/totalOut fields. Read the actual state.
    const completed = await zip.getZStream();
    const size = completed.totalOut === undefined ? -1 : completed.totalOut;
    if (status !== zlib.ReturnStatus.STREAM_END || size < 0 || size > maxOutputBytes ||
      completed.totalIn !== data.byteLength || !stream.nextOut) {
      throw new Error('表格压缩数据不完整或展开内容超过限制。');
    }
    return new Uint8Array(stream.nextOut.slice(0, size));
  } finally {
    if (initialized) await zip.inflateEnd(stream);
  }
}

/** undefined is a normal picker cancellation. This service never writes the ledger. */
export async function readBillFile(context: common.UIAbilityContext): Promise<BillFile | undefined> {
  let choices: string[];
  try {
    const documentPicker = new picker.DocumentViewPicker(context);
    choices = await documentPicker.select({
      maxSelectNumber: 1,
      fileSuffixFilters: ['账单文件|.csv,.xlsx']
    });
  } catch (error) {
    throw new Error('无法打开文件选择器，请返回记账页面后重试。');
  }
  if (choices.length === 0) return undefined;
  return readBillUri(choices[0]);
}

/** Shared URI reader for a system-picked file; no persistent authorization or file copying. */
export async function readBillUri(uri: string): Promise<BillFile> {
  try {
    const selected = await readSelected(uri);
    const name = selected.name;
    const suffix = name.toLowerCase();
    if (suffix.endsWith('.xlsx')) {
      const rows = await readXlsxRows(selected.bytes, inflateSpreadsheet);
      return { name, format: 'xlsx', rows };
    }
    if (!suffix.endsWith('.csv')) throw new Error('目前支持 CSV 和 XLSX，请先解压账单或导出为这些格式。');
    const rows = parseCsv(decodeCsv(selected.bytes));
    return { name, format: 'csv', rows };
  } catch (error) {
    const failure = error as Error;
    const code = (error as BusinessError).code;
    if (code) throw new Error('无法读取账单文件，请重新选择或重新导出。');
    throw new Error(failure.message || '账单读取失败，请重新选择。');
  }
}

/** OCR is local Core Vision Kit. Huawei documents that Core Vision does not support emulators. */
export async function recognizeReceiptFile(uri: string): Promise<string> {
  if (recognizing) throw new Error('正在识别上一张截图，请稍后再试。');
  if (!canIUse('SystemCapability.AI.OCR.TextRecognition')) {
    throw new Error('当前设备不支持文字识别。可粘贴截图中的文字或手动录入；模拟器不支持端侧 OCR。');
  }
  recognizing = true;
  let source: image.ImageSource | undefined = undefined;
  let pixels: image.PixelMap | undefined = undefined;
  try {
    const selected = await readSelected(uri);
    const bytes = selected.bytes;
    const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) throw new Error('请选择 PNG 或 JPG 格式的支付截图。');
    source = image.createImageSource(bytes.buffer as ArrayBuffer);
    const info = await source.getImageInfo();
    const width = info.size.width;
    const height = info.size.height;
    if (width <= 100 || height <= 100 || width >= 10000 || height >= 15210 || width * height > MAX_IMAGE_PIXELS) {
      throw new Error('截图尺寸不合适，请裁剪到一笔支付详情后重试。');
    }
    const scale = Math.min(1, 4096 / Math.max(width, height), Math.sqrt(8 * 1024 * 1024 / (width * height)));
    pixels = await source.createPixelMap({
      desiredPixelFormat: image.PixelMapFormat.RGBA_8888,
      desiredSize: { width: Math.max(101, Math.floor(width * scale)), height: Math.max(101, Math.floor(height * scale)) }
    });
    const result = await textRecognition.recognizeText({ pixelMap: pixels }, { isDirectionDetectionSupported: true });
    const text = result.value.trim();
    if (!text) throw new Error('没有识别到文字，请选择清晰的支付详情截图，或粘贴文字。');
    if (text.length > 10000) throw new Error('截图内容过多，请裁剪到一笔支付详情后重试。');
    return text;
  } catch (error) {
    const code = (error as BusinessError).code;
    if (code === 200) throw new Error('文字识别超时，请裁剪截图后重试，或粘贴文字。');
    if (code === 1001400001 || code === 1001400002 || code === 801) {
      throw new Error('当前设备的文字识别服务不可用。可粘贴文字继续录入；模拟器不支持端侧 OCR。');
    }
    if (code) throw new Error('截图读取或识别失败，请选择清晰的 PNG/JPG 截图，或粘贴文字。');
    throw new Error((error as Error).message || '截图识别失败，请重新选择或粘贴文字。');
  } finally {
    try {
      if (pixels) await pixels.release();
    } finally {
      try {
        if (source) await source.release();
      } finally {
        recognizing = false;
      }
    }
  }
}

/** Only the selected image is read. Cancelling the system picker returns undefined. */
export async function recognizeReceipt(context: common.UIAbilityContext): Promise<string | undefined> {
  // Keep a UIAbilityContext in the public contract; PhotoViewPicker uses the active UI context itself.
  if (!context) throw new Error('页面已关闭，请重新打开后选择截图。');
  let selection: photoAccessHelper.PhotoSelectResult;
  try {
    const photoPicker = new photoAccessHelper.PhotoViewPicker();
    selection = await photoPicker.select({
      MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
      maxSelectNumber: 1
    });
  } catch (error) {
    throw new Error('无法选择截图，请重试或粘贴文字。');
  }
  if (selection.photoUris.length === 0) return undefined;
  return recognizeReceiptFile(selection.photoUris[0]);
}

/** Downloaded receipt images need not be copied into the user's photo library. */
export async function recognizeReceiptDocument(context: common.UIAbilityContext): Promise<string | undefined> {
  try {
    const selected = await new picker.DocumentViewPicker(context).select({
      maxSelectNumber: 1, fileSuffixFilters: ['账单截图|.png,.jpg,.jpeg']
    });
    if (selected.length === 0) { return undefined; }
    return await recognizeReceiptFile(selected[0]);
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(message || '无法读取截图文件，请重新选择 PNG 或 JPG。');
  }
}
