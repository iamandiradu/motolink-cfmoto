/**
 * Byte helpers. Self-contained on purpose: the protocol core must run the same
 * under Hermes and under Node (tests), without relying on TextDecoder/atob.
 */

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    let cp: number;
    if (b0 < 0x80) cp = b0;
    else if (b0 >= 0xc0 && b0 < 0xe0 && i < bytes.length) cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < bytes.length)
      cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else if (b0 >= 0xf0 && i + 2 < bytes.length)
      cp =
        ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = 0xfffd;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  const clean: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v >= 0) clean.push(v);
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n =
      (clean[i] << 18) | (clean[i + 1] << 12) | ((clean[i + 2] ?? 0) << 6) | (clean[i + 3] ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

export function hex(bytes: Uint8Array, max = 64): string {
  const shown = bytes.subarray(0, max);
  let out = '';
  for (let i = 0; i < shown.length; i++) out += (i ? ' ' : '') + shown[i].toString(16).padStart(2, '0');
  return bytes.length > max ? `${out} …(+${bytes.length - max})` : out;
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Accumulates stream chunks and hands back complete records. */
export class ByteQueue {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    this.buf = this.buf.length === 0 ? chunk.slice() : concatBytes(this.buf, chunk);
  }

  get length(): number {
    return this.buf.length;
  }

  peek(): Uint8Array {
    return this.buf;
  }

  take(n: number): Uint8Array {
    const head = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return head;
  }

  clear(): void {
    this.buf = new Uint8Array(0);
  }
}
