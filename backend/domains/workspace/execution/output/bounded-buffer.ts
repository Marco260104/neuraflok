import { formatOutputOmissionMarker, UNIFIED_EXEC_OUTPUT_MAX_BYTES } from '../unified-exec-constants.js';

class ByteRing {
  private bytes = Buffer.alloc(0);
  private start = 0;
  private length = 0;

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.length;
  }

  append(chunk: Buffer): number {
    if (chunk.length === 0) return 0;
    if (this.limit === 0) return chunk.length;
    if (chunk.length >= this.limit) return this.replaceWithSuffix(chunk);

    const dropped = Math.max(0, this.length + chunk.length - this.limit);
    this.start = this.bytes.length === 0 ? 0 : (this.start + dropped) % this.bytes.length;
    this.length -= dropped;
    this.reserve(this.length + chunk.length);
    const writeAt = (this.start + this.length) % this.bytes.length;
    const firstLength = Math.min(chunk.length, this.bytes.length - writeAt);
    chunk.copy(this.bytes, writeAt, 0, firstLength);
    if (firstLength < chunk.length) chunk.copy(this.bytes, 0, firstLength);
    this.length += chunk.length;
    return dropped;
  }

  read(): Buffer {
    const output = Buffer.allocUnsafe(this.length);
    if (this.length === 0) return output;
    const firstLength = Math.min(this.length, this.bytes.length - this.start);
    this.bytes.copy(output, 0, this.start, this.start + firstLength);
    if (firstLength < this.length) this.bytes.copy(output, firstLength, 0, this.length - firstLength);
    return output;
  }

  private replaceWithSuffix(chunk: Buffer): number {
    const dropped = this.length + chunk.length - this.limit;
    this.reserve(this.limit);
    chunk.copy(this.bytes, 0, chunk.length - this.limit);
    this.start = 0;
    this.length = this.limit;
    return dropped;
  }

  private reserve(required: number): void {
    if (required <= this.bytes.length) return;
    const size = Math.min(this.limit, Math.max(required, this.bytes.length * 2, 4_096));
    const expanded = Buffer.allocUnsafe(size);
    if (this.length > 0) {
      const firstLength = Math.min(this.length, this.bytes.length - this.start);
      this.bytes.copy(expanded, 0, this.start, this.start + firstLength);
      if (firstLength < this.length) this.bytes.copy(expanded, firstLength, 0, this.length - firstLength);
    }
    this.bytes = expanded;
    this.start = 0;
  }
}

export class BoundedOutputBuffer {
  private readonly headLimit: number;
  private readonly tail: ByteRing;
  private head = Buffer.alloc(0);
  private headLength = 0;
  private omitted = 0;

  constructor(maxBytes: number = UNIFIED_EXEC_OUTPUT_MAX_BYTES) {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : UNIFIED_EXEC_OUTPUT_MAX_BYTES;
    this.headLimit = Math.floor(limit / 2);
    this.tail = new ByteRing(limit - this.headLimit);
  }

  retainedBytes(): number {
    return this.headLength + this.tail.size;
  }

  omittedBytes(): number {
    return this.omitted;
  }

  totalBytes(): number {
    return this.retainedBytes() + this.omitted;
  }

  pushChunk(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const prefixLength = Math.min(this.headLimit - this.headLength, chunk.length);
    if (prefixLength > 0) {
      if (this.head.length === 0) this.head = Buffer.alloc(this.headLimit);
      chunk.copy(this.head, this.headLength, 0, prefixLength);
      this.headLength += prefixLength;
    }
    this.omitted += this.tail.append(chunk.subarray(prefixLength));
  }

  toBytes(): Buffer {
    return Buffer.concat([this.head.subarray(0, this.headLength), this.tail.read()], this.retainedBytes());
  }

  toBytesWithOmissionMarker(): Buffer {
    if (this.omitted === 0) return this.toBytes();
    return Buffer.concat([
      this.head.subarray(0, this.headLength),
      Buffer.from('\n'),
      Buffer.from(formatOutputOmissionMarker(this.omitted), 'utf8'),
      Buffer.from('\n'),
      this.tail.read()
    ]);
  }

  pushBuffer(other: BoundedOutputBuffer): void {
    const retained = other.toBytes();
    const omitted = other.omittedBytes();
    this.pushChunk(retained);
    this.omitted += omitted;
  }
}
