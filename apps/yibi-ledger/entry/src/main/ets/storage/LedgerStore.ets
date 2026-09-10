import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { LedgerEntry, encodeLedger, decodeLedger } from '../model/Ledger';

/**
 * Private application storage. All instances in this process share a path queue.
 * A complete temp file is flushed and closed before replacing the live ledger.
 * Callers must await save before displaying a successful in-memory edit.
 *
 * API references (OpenHarmony official documentation):
 * https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-core-file-kit/js-apis-file-fs.md
 * https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-arkts/js-apis-util.md
 */
export class LedgerStore {
  private static queues: Map<string, Promise<void>> = new Map<string, Promise<void>>();
  private filePath: string;

  constructor(context: common.Context) {
    this.filePath = context.filesDir + '/ledger-v1.json';
  }

  load(): Promise<LedgerEntry[]> {
    return this.enqueue<LedgerEntry[]>(() => this.readCurrent());
  }

  save(entries: LedgerEntry[]): Promise<void> {
    // Capture and validate now so callers cannot mutate a pending write's payload.
    let raw: string;
    try {
      raw = encodeLedger(entries);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue<void>(async () => {
      // Never replace a corrupt/unreadable ledger, even if save is called before load.
      await this.readCurrent();
      await this.writeAtomic(raw);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let previous = LedgerStore.queues.get(this.filePath);
    if (previous === undefined) {
      previous = Promise.resolve();
    }
    const result: Promise<T> = previous.then(operation);
    // A failed operation must reject its caller while allowing a later retry.
    const settled: Promise<void> = result.then(() => {}, () => {});
    LedgerStore.queues.set(this.filePath, settled);
    return result;
  }

  private async readCurrent(): Promise<LedgerEntry[]> {
    let raw: string;
    try {
      raw = await fs.readText(this.filePath, { encoding: 'utf-8' });
    } catch (error) {
      const fileError = error as BusinessError;
      // Official Basic File IO error: 13900002 = no such file or directory.
      if (fileError.code === 13900002) {
        return [];
      }
      throw new Error('无法读取本机账本，请重试。错误码：' + String(fileError.code));
    }
    return decodeLedger(raw);
  }

  private async writeAtomic(raw: string): Promise<void> {
    const temporaryPath = this.filePath + '.tmp';
    const bytes: Uint8Array = new util.TextEncoder('utf-8').encodeInto(raw);
    const buffer: ArrayBuffer = bytes.buffer as ArrayBuffer;
    const file: fs.File = await fs.open(temporaryPath,
      fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const remaining: ArrayBuffer = buffer.slice(bytes.byteOffset + written,
          bytes.byteOffset + bytes.byteLength);
        const count = await fs.write(file.fd, remaining, { offset: written });
        if (count <= 0 || count > remaining.byteLength) {
          throw new Error('账本写入未完成，原始数据已保留');
        }
        written += count;
      }
      await fs.fsync(file.fd);
    } finally {
      await fs.close(file);
    }
    // Detect incomplete or damaged writes before changing the live ledger.
    const verification = await fs.readText(temporaryPath, { encoding: 'utf-8' });
    if (verification !== raw) {
      throw new Error('账本写入校验失败，原始数据已保留');
    }
    await fs.rename(temporaryPath, this.filePath);
  }
}
