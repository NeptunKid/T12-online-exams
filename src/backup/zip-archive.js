const zlib = require("node:zlib");

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function normalizeEntryName(value) {
  const name = String(value || "").replace(/\\/g, "/");
  if (!name || name.startsWith("/") || name.includes("\0")) throw new Error("ZIP 文件路径无效");
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("ZIP 文件路径无效");
  return parts.join("/");
}

function createZip(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("ZIP 至少需要一个文件");
  if (entries.length > 5000) throw new Error("ZIP 文件数量过多");
  const names = new Set();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry?.name);
    if (names.has(name)) throw new Error(`ZIP 文件路径重复：${name}`);
    names.add(name);
    const nameBuffer = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "");
    const checksum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function findEndRecord(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new Error("不是有效的 ZIP 备份包");
}

function readZip(input, limits = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const maxEntries = Number(limits.maxEntries || 5000);
  const maxEntryBytes = Number(limits.maxEntryBytes || 6 * 1024 * 1024);
  const maxTotalBytes = Number(limits.maxTotalBytes || 100 * 1024 * 1024);
  if (buffer.length < 22 || buffer.length > Number(limits.maxArchiveBytes || 100 * 1024 * 1024)) {
    throw new Error("ZIP 备份包大小无效");
  }
  const endOffset = findEndRecord(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount > maxEntries) {
    throw new Error("不支持分卷或文件数量过多的 ZIP");
  }
  if (endOffset + 22 + commentLength !== buffer.length || centralOffset + centralSize > endOffset) {
    throw new Error("ZIP 目录结构无效");
  }

  const files = new Map();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error("ZIP 中央目录无效");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (next > endOffset || (flags & 0x0001) || ![0, 8].includes(method)) throw new Error("ZIP 文件使用了不支持的功能");
    const name = normalizeEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    if (files.has(name) || size > maxEntryBytes || totalBytes + size > maxTotalBytes) {
      throw new Error("ZIP 文件重复或解压后过大");
    }
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error("ZIP 本地文件头无效");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) throw new Error("ZIP 文件正文越界");
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    try {
      content = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    } catch (_) {
      throw new Error(`ZIP 文件解压失败：${name}`);
    }
    if (content.length !== size || crc32(content) !== checksum) throw new Error(`ZIP 文件校验失败：${name}`);
    files.set(name, content);
    totalBytes += content.length;
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP 中央目录长度无效");
  return files;
}

module.exports = { createZip, crc32, normalizeEntryName, readZip };
