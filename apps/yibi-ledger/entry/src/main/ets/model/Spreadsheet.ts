/** Bounded OOXML reader. No filesystem extraction, formula evaluation or network access. */
export type RawInflater = (data: Uint8Array, maxOutputBytes: number) => Promise<Uint8Array>;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 200;
const MAX_ROWS = 5100; // Allows export notices plus at most 5000 transactions (validated by BillImport).
const MAX_COLUMNS = 128;
const MAX_CELLS = 150000;
const MAX_XML_NODES = 450000;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  start: number;
}

interface XmlNode {
  name: string;
  attributes: Map<string, string>;
  children: XmlNode[];
  text: string;
}

function invalid(message: string): never {
  throw new Error(message);
}

/** Strict UTF-8, shared with ZIP names and OOXML parts; never substitutes corrupted characters. */
export function decodeSpreadsheetUtf8(bytes: Uint8Array): string {
  const output: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let point = first;
    let trailing = 0;
    let minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      point = first & 31; trailing = 1; minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      point = first & 15; trailing = 2; minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      point = first & 7; trailing = 3; minimum = 0x10000;
    } else if (first > 0x7f) {
      invalid('文件不是有效的 UTF-8 文本。');
    }
    if (index + trailing > bytes.length) invalid('文件文本被截断，请重新导出。');
    for (let part = 0; part < trailing; part++) {
      const next = bytes[index++];
      if ((next & 0xc0) !== 0x80) invalid('文件文本编码损坏，请重新导出。');
      point = point * 64 + (next & 63);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      invalid('文件文本编码无效，请重新导出。');
    }
    chunk += String.fromCodePoint(point);
    if (chunk.length >= 4096) {
      output.push(chunk);
      chunk = '';
    }
  }
  output.push(chunk);
  return output.join('').replace(/^\uFEFF/, '');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function directory(bytes: Uint8Array): Map<string, ZipEntry> {
  if (bytes.length < 22 || bytes.length > MAX_FILE_BYTES) invalid('请选择不超过 8 MiB 的 XLSX 账单。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && (view.getUint32(end, true) !== 0x06054b50 ||
    end + 22 + view.getUint16(end + 20, true) !== bytes.length)) end--;
  if (end < minimum) invalid('文件不是完整的 XLSX，请重新导出。');
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count || count > MAX_ENTRIES || count === 0 ||
    offset + size !== end) invalid('不支持分卷、ZIP64 或结构异常的 XLSX 文件。');
  const entries = new Map<string, ZipEntry>();
  let cursor = offset;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) invalid('XLSX 文件目录损坏。');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const recordSize = 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (cursor + recordSize > end || nameLength === 0 || nameLength > 512) invalid('XLSX 文件目录损坏。');
    const name = decodeSpreadsheetUtf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const parts = name.split('/');
    if (name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0') ||
      parts.some((part: string) => part === '..' || part === '.') || entries.has(name)) {
      invalid('XLSX 包含重复或不安全的文件路径。');
    }
    if ((flags & 0x2041) !== 0 || (method !== 0 && method !== 8) ||
      view.getUint16(cursor + 34, true) !== 0 ||
      ((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000) {
      invalid('不支持加密、链接或特殊压缩格式的 XLSX，请另存为普通 XLSX。');
    }
    expanded += uncompressedSize;
    if (expanded > MAX_EXPANDED_BYTES || uncompressedSize > 16 * 1024 * 1024) {
      invalid('XLSX 展开后过大，请缩短导出日期范围。');
    }
    const local = view.getUint32(cursor + 42, true);
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) {
      invalid('XLSX 文件头与目录不一致。');
    }
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (start + compressedSize > offset || start < local || localNameLength !== nameLength ||
      decodeSpreadsheetUtf8(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) {
      invalid('XLSX 文件内容越界或名称不一致。');
    }
    const crc = view.getUint32(cursor + 16, true);
    if ((flags & 8) === 0 && (view.getUint32(local + 14, true) !== crc ||
      view.getUint32(local + 18, true) !== compressedSize || view.getUint32(local + 22, true) !== uncompressedSize)) {
      invalid('XLSX 文件长度校验失败。');
    }
    entries.set(name, { name, method, compressedSize, size: uncompressedSize, crc, start });
    cursor += recordSize;
  }
  if (cursor !== end) invalid('XLSX 目录长度不一致。');
  return entries;
}

function entityText(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(text)) invalid('XLSX 文本包含无效实体。');
  return text.replace(/&([^;]+);/g, (_match: string, name: string): string => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    const point = name.startsWith('#x') ? parseInt(name.substring(2), 16) : Number(name.substring(1));
    if (!Number.isInteger(point) || (point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      point === 0xfffe || point === 0xffff || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      invalid('XLSX 文本包含无效字符。');
    }
    return String.fromCodePoint(point);
  });
}

function localName(name: string): string {
  const parts = name.split(':');
  return parts[parts.length - 1];
}

function xml(text: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) invalid('不支持包含外部实体或 DTD 的表格。');
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(text)) invalid('XLSX XML 包含无效控制字符。');
  const root: XmlNode = { name: '#document', attributes: new Map<string, string>(), children: [], text: '' };
  const stack: XmlNode[] = [root];
  let cursor = 0;
  let nodes = 0;
  while (cursor < text.length) {
    const opening = text.indexOf('<', cursor);
    const parent = stack[stack.length - 1];
    if (opening < 0) {
      parent.text += entityText(text.substring(cursor));
      break;
    }
    parent.text += entityText(text.substring(cursor, opening));
    if (text.startsWith('<!--', opening)) {
      const end = text.indexOf('-->', opening + 4);
      if (end < 0) invalid('XLSX 注释未闭合。');
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<?', opening)) {
      const end = text.indexOf('?>', opening + 2);
      if (end < 0) invalid('XLSX 声明未闭合。');
      cursor = end + 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', opening)) {
      const end = text.indexOf(']]>', opening + 9);
      if (end < 0) invalid('XLSX 文本块未闭合。');
      parent.text += text.substring(opening + 9, end);
      cursor = end + 3;
      continue;
    }
    let end = opening + 1;
    let quote = '';
    while (end < text.length) {
      const character = text[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      end++;
    }
    if (end >= text.length) invalid('XLSX XML 未闭合。');
    const token = text.substring(opening + 1, end).trim();
    if (token.startsWith('/')) {
      if (stack.length === 1 || parent.name !== token.substring(1).trim()) invalid('XLSX XML 标签不匹配。');
      stack.pop();
    } else {
      const match = /^([A-Za-z_][\w.:-]*)([\s\S]*?)\/?$/.exec(token);
      if (!match) invalid('XLSX XML 标签无效。');
      const node: XmlNode = { name: match[1], attributes: new Map<string, string>(), children: [], text: '' };
      let attrs = match[2].trim();
      while (attrs) {
        const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')\s*/.exec(attrs);
        if (!attr || node.attributes.has(attr[1])) invalid('XLSX XML 属性无效。');
        node.attributes.set(attr[1], entityText(attr[2].substring(1, attr[2].length - 1)));
        attrs = attrs.substring(attr[0].length);
      }
      if (++nodes > MAX_XML_NODES || stack.length > 48) invalid('XLSX 结构过于复杂，请缩短日期范围。');
      parent.children.push(node);
      if (!token.endsWith('/')) stack.push(node);
    }
    cursor = end + 1;
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim()) invalid('XLSX XML 结构不完整。');
  return root.children[0];
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((item: XmlNode) => localName(item.name) === name);
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((item: XmlNode) => localName(item.name) === name);
}

function inlineText(node: XmlNode): string {
  if (localName(node.name) === 'rPh') return '';
  if (localName(node.name) === 't') return node.text;
  return node.children.map((item: XmlNode) => inlineText(item)).join('');
}

function dateStyles(styles: XmlNode | undefined): boolean[] {
  if (!styles) return [];
  const formats = new Map<number, string>();
  const numFmts = child(styles, 'numFmts');
  if (numFmts) for (const format of children(numFmts, 'numFmt')) {
    formats.set(Number(format.attributes.get('numFmtId')), format.attributes.get('formatCode') || '');
  }
  const cellXfs = child(styles, 'cellXfs');
  if (!cellXfs) return [];
  return children(cellXfs, 'xf').map((format: XmlNode) => {
    const id = Number(format.attributes.get('numFmtId'));
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const pattern = (formats.get(id) || '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    return /[ydh]/i.test(pattern);
  });
}

function excelDate(value: string, date1904: boolean): string {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) invalid('表格日期无效。');
  if (!date1904 && Math.floor(serial) === 60) invalid('表格包含无效的 1900-02-29 日期。');
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const date = new Date(base + Math.round((serial - (!date1904 && serial >= 60 ? 1 : 0)) * 86400) * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ` +
    `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

/** Returns only the first visible worksheet. All cells stay strings, including long transaction IDs. */
export async function readXlsxRows(bytes: Uint8Array, inflateRaw: RawInflater): Promise<string[][]> {
  const entries = directory(bytes);
  const load = async (name: string, required: boolean): Promise<XmlNode | undefined> => {
    const entry = entries.get(name);
    if (!entry) {
      if (required) invalid('XLSX 缺少必要的工作表文件。');
      return undefined;
    }
    const compressed = bytes.slice(entry.start, entry.start + entry.compressedSize);
    const plain = entry.method === 0 ? compressed : await inflateRaw(compressed, entry.size);
    if (plain.byteLength !== entry.size || crc32(plain) !== entry.crc) invalid('XLSX 解压长度或校验码不匹配。');
    return xml(decodeSpreadsheetUtf8(plain));
  };
  const workbook = await load('xl/workbook.xml', true);
  const relationships = await load('xl/_rels/workbook.xml.rels', true);
  if (!workbook || !relationships || localName(workbook.name) !== 'workbook' ||
    localName(relationships.name) !== 'Relationships') invalid('XLSX 工作簿结构无效。');
  const sheets = child(workbook, 'sheets');
  const sheet = sheets ? children(sheets, 'sheet').find((item: XmlNode) => {
    const state = item.attributes.get('state');
    return state === undefined || state === 'visible';
  }) : undefined;
  if (!sheet) invalid('XLSX 没有可见工作表。');
  const relationId = sheet.attributes.get('r:id');
  if (!relationId) invalid('XLSX 工作表缺少引用标识。');
  const matching = children(relationships, 'Relationship').filter((item: XmlNode) => item.attributes.get('Id') === relationId);
  if (matching.length !== 1) invalid('XLSX 工作表引用缺失或重复。');
  const relation = matching[0];
  if (!relation || relation.attributes.get('TargetMode') === 'External') invalid('不支持外部链接工作表。');
  let target = relation.attributes.get('Target') || '';
  if (target.startsWith('/')) target = target.substring(1);
  else target = 'xl/' + target;
  if (!/^xl\/worksheets\/[^/\\:]+\.xml$/.test(target) || target.includes('..')) invalid('XLSX 工作表引用无效。');
  const stringsPart = await load('xl/sharedStrings.xml', false);
  const strings: string[] = stringsPart ? children(stringsPart, 'si').map((item: XmlNode) => inlineText(item)) : [];
  if (strings.length > MAX_CELLS || strings.some((item: string) => item.length > 8192)) invalid('XLSX 文本内容过多。');
  const styles = dateStyles(await load('xl/styles.xml', false));
  const worksheet = await load(target, true);
  if (worksheet && localName(worksheet.name) !== 'worksheet') invalid('XLSX 工作表结构无效。');
  const sheetData = worksheet ? child(worksheet, 'sheetData') : undefined;
  if (!sheetData) invalid('XLSX 没有表格数据。');
  const properties = child(workbook, 'workbookPr');
  const date1904 = properties?.attributes.get('date1904') === '1' || properties?.attributes.get('date1904') === 'true';
  const rows: string[][] = [];
  let cellCount = 0;
  for (const row of children(sheetData, 'row')) {
    if (rows.length >= MAX_ROWS) invalid('表格行数过多，请每次导入不超过 5000 笔明细。');
    const values: string[] = [];
    for (const cell of children(row, 'c')) {
      if (++cellCount > MAX_CELLS) invalid('表格单元格过多，请缩短导出日期范围。');
      if (child(cell, 'f')) invalid('账单中包含公式，请导出原始账单或另存为仅含值的表格。');
      const address = cell.attributes.get('r') || '';
      const match = /^([A-Z]+)[1-9]\d*$/.exec(address);
      let column = values.length;
      if (match) {
        column = 0;
        for (let index = 0; index < match[1].length; index++) column = column * 26 + match[1].charCodeAt(index) - 64;
        column--;
      } else if (address) invalid('XLSX 单元格地址无效。');
      if (column < values.length || column >= MAX_COLUMNS) invalid('表格列过多或单元格顺序异常。');
      while (values.length <= column) values.push('');
      const type = cell.attributes.get('t') || 'n';
      const raw = child(cell, 'v')?.text || '';
      let value = raw;
      if (type === 's') {
        const id = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id >= strings.length) invalid('XLSX 共享文本索引无效。');
        value = strings[id];
      } else if (type === 'inlineStr') {
        const inline = child(cell, 'is');
        value = inline ? inlineText(inline) : '';
      } else if (type === 'e') invalid('账单包含错误单元格，请重新导出。');
      else if (type === 'n' && raw && styles[Number(cell.attributes.get('s') || '0')]) value = excelDate(raw, date1904);
      if (value.length > 8192) invalid('单元格内容过长，请检查是否为账单文件。');
      values[column] = value;
    }
    if (values.some((value: string) => value.trim().length > 0)) rows.push(values);
  }
  return rows;
}
