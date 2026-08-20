/**
 * GGUF metadata parser.
 *
 * Reads the GGUF header and extracts all metadata key/value pairs from the
 * metadata section. This is intentionally minimal: it does not interpret
 * tensors or quantization, only the header key/value store.
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";

export interface GgufMetadata {
  readonly version: number;
  readonly tensorCount: bigint;
  readonly kvCount: bigint;
  readonly fields: Record<string, unknown>;
}

const GGUF_MAGIC = "GGUF";
const BUFFER_SIZE = 65536;

class GgufReader {
  private buffer: Buffer;
  private bufferOffset = 0;
  private bufferLength = 0;
  private fileOffset = 0;
  private readonly fd: number;
  private readonly fileSize: number;

  constructor(filePath: string) {
    this.fd = openSync(filePath, "r");
    this.fileSize = statSync(filePath).size;
    this.buffer = Buffer.alloc(BUFFER_SIZE);
  }

  private ensureAvailable(count: number): void {
    if (this.bufferOffset + count <= this.bufferLength) return;
    const remaining = this.bufferLength - this.bufferOffset;
    if (remaining > 0) {
      this.buffer.copy(this.buffer, 0, this.bufferOffset, this.bufferLength);
    }
    this.bufferOffset = 0;
    this.bufferLength = remaining;
    const toRead = Math.min(BUFFER_SIZE - this.bufferLength, this.fileSize - this.fileOffset);
    if (toRead <= 0) throw new Error("Unexpected end of GGUF file");
    const bytesRead = readSync(this.fd, this.buffer, this.bufferLength, toRead, this.fileOffset);
    this.bufferLength += bytesRead;
    this.fileOffset += bytesRead;
  }

  readUInt8(): number {
    this.ensureAvailable(1);
    const v = this.buffer.readUInt8(this.bufferOffset);
    this.bufferOffset += 1;
    return v;
  }

  readInt8(): number {
    this.ensureAvailable(1);
    const v = this.buffer.readInt8(this.bufferOffset);
    this.bufferOffset += 1;
    return v;
  }

  readUInt16LE(): number {
    this.ensureAvailable(2);
    const v = this.buffer.readUInt16LE(this.bufferOffset);
    this.bufferOffset += 2;
    return v;
  }

  readInt16LE(): number {
    this.ensureAvailable(2);
    const v = this.buffer.readInt16LE(this.bufferOffset);
    this.bufferOffset += 2;
    return v;
  }

  readUInt32LE(): number {
    this.ensureAvailable(4);
    const v = this.buffer.readUInt32LE(this.bufferOffset);
    this.bufferOffset += 4;
    return v;
  }

  readInt32LE(): number {
    this.ensureAvailable(4);
    const v = this.buffer.readInt32LE(this.bufferOffset);
    this.bufferOffset += 4;
    return v;
  }

  readFloat32LE(): number {
    this.ensureAvailable(4);
    const v = this.buffer.readFloatLE(this.bufferOffset);
    this.bufferOffset += 4;
    return v;
  }

  readUInt64LE(): bigint {
    this.ensureAvailable(8);
    const v = this.buffer.readBigUInt64LE(this.bufferOffset);
    this.bufferOffset += 8;
    return v;
  }

  readInt64LE(): bigint {
    this.ensureAvailable(8);
    const v = this.buffer.readBigInt64LE(this.bufferOffset);
    this.bufferOffset += 8;
    return v;
  }

  readFloat64LE(): number {
    this.ensureAvailable(8);
    const v = this.buffer.readDoubleLE(this.bufferOffset);
    this.bufferOffset += 8;
    return v;
  }

  readBool(): boolean {
    return this.readUInt8() !== 0;
  }

  readString(): string {
    const len = Number(this.readUInt64LE());
    this.ensureAvailable(len);
    const v = this.buffer.subarray(this.bufferOffset, this.bufferOffset + len).toString("utf8");
    this.bufferOffset += len;
    return v;
  }

  close(): void {
    closeSync(this.fd);
  }
}

export function parseGgufMetadata(filePath: string): GgufMetadata {
  const reader = new GgufReader(filePath);
  try {
    const magicBytes = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) magicBytes[i] = reader.readUInt8();
    const magic = magicBytes.toString("ascii");
    if (magic !== GGUF_MAGIC) {
      throw new Error(`Invalid GGUF magic: ${magic}`);
    }

    const version = reader.readUInt32LE();
    const tensorCount = reader.readUInt64LE();
    const kvCount = reader.readUInt64LE();

    const fields: Record<string, unknown> = {};

    for (let i = 0; i < Number(kvCount); i++) {
      const key = reader.readString();
      const valueType = reader.readUInt32LE();

      switch (valueType) {
        case 0: fields[key] = reader.readUInt8(); break;
        case 1: fields[key] = reader.readInt8(); break;
        case 2: fields[key] = reader.readUInt16LE(); break;
        case 3: fields[key] = reader.readInt16LE(); break;
        case 4: fields[key] = reader.readUInt32LE(); break;
        case 5: fields[key] = reader.readInt32LE(); break;
        case 6: fields[key] = reader.readFloat32LE(); break;
        case 7: fields[key] = reader.readBool(); break;
        case 8: fields[key] = reader.readString(); break;
        case 9: {
          const elemType = reader.readUInt32LE();
          const len = Number(reader.readUInt64LE());
          const arr: unknown[] = [];
          for (let j = 0; j < len; j++) {
            switch (elemType) {
              case 0: arr.push(reader.readUInt8()); break;
              case 1: arr.push(reader.readInt8()); break;
              case 2: arr.push(reader.readUInt16LE()); break;
              case 3: arr.push(reader.readInt16LE()); break;
              case 4: arr.push(reader.readUInt32LE()); break;
              case 5: arr.push(reader.readInt32LE()); break;
              case 6: arr.push(reader.readFloat32LE()); break;
              case 7: arr.push(reader.readBool()); break;
              case 8: arr.push(reader.readString()); break;
              case 10: arr.push(reader.readUInt64LE()); break;
              case 11: arr.push(reader.readInt64LE()); break;
              case 12: arr.push(reader.readFloat64LE()); break;
              default: throw new Error(`Unsupported GGUF array element type: ${elemType}`);
            }
          }
          fields[key] = arr;
          break;
        }
        case 10: fields[key] = reader.readUInt64LE(); break;
        case 11: fields[key] = reader.readInt64LE(); break;
        case 12: fields[key] = reader.readFloat64LE(); break;
        default: throw new Error(`Unsupported GGUF value type: ${valueType}`);
      }
    }

    return {
      version,
      tensorCount,
      kvCount,
      fields,
    };
  } finally {
    reader.close();
  }
}
