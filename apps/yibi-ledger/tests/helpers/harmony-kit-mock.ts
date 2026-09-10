/** In-memory implementation of the documented API surface, for fault injection only. */
interface MockFile {
  fd: number;
}

interface MockState {
  files: Map<string, Uint8Array>;
  handles: Map<number, string>;
  nextFd: number;
  maxWriteBytes: number;
  failNext: string;
  events: string[];
}

export const state: MockState = {
  files: new Map(), handles: new Map(), nextFd: 1,
  maxWriteBytes: Number.MAX_SAFE_INTEGER, failNext: '', events: []
};

export function reset(): void {
  state.files.clear();
  state.handles.clear();
  state.nextFd = 1;
  state.maxWriteBytes = Number.MAX_SAFE_INTEGER;
  state.failNext = '';
  state.events.length = 0;
}

export function readStored(path: string): string | undefined {
  const bytes = state.files.get(path);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

export function seed(path: string, text: string): void {
  state.files.set(path, new TextEncoder().encode(text));
}

export class BusinessError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const common = {};
export const util = {
  TextEncoder: class {
    constructor(_encoding?: string) {}
    encodeInto(text: string): Uint8Array {
      return new TextEncoder().encode(text);
    }
  }
};

function event(name: string): void {
  state.events.push(name);
  if (state.failNext === name) {
    state.failNext = '';
    throw new BusinessError(13900005, 'Injected I/O failure');
  }
}

export const fileIo = {
  OpenMode: { WRITE_ONLY: 1, CREATE: 2, TRUNC: 4 },
  async readText(path: string, _options?: { encoding: string }): Promise<string> {
    event('read');
    const value = readStored(path);
    if (value === undefined) {
      throw new BusinessError(13900002, 'No such file or directory');
    }
    return value;
  },
  async open(path: string, _flags: number): Promise<MockFile> {
    event('open');
    state.files.set(path, new Uint8Array());
    const fd = state.nextFd++;
    state.handles.set(fd, path);
    return { fd };
  },
  async write(fd: number, buffer: ArrayBuffer, options: { offset: number }): Promise<number> {
    event('write');
    const path = state.handles.get(fd);
    if (path === undefined) throw new Error('Closed file descriptor');
    const previous = state.files.get(path) ?? new Uint8Array();
    const amount = Math.min(buffer.byteLength, state.maxWriteBytes);
    const next = new Uint8Array(Math.max(previous.byteLength, options.offset + amount));
    next.set(previous);
    next.set(new Uint8Array(buffer, 0, amount), options.offset);
    state.files.set(path, next);
    return amount;
  },
  async fsync(_fd: number): Promise<void> {
    event('fsync');
  },
  async close(file: MockFile): Promise<void> {
    event('close');
    state.handles.delete(file.fd);
  },
  async rename(source: string, target: string): Promise<void> {
    event('rename');
    const bytes = state.files.get(source);
    if (bytes === undefined) throw new BusinessError(13900002, 'Missing temp file');
    state.files.set(target, bytes);
    state.files.delete(source);
  }
};
