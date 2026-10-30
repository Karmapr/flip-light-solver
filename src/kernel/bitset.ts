/**
 * 位集原语。
 *
 * 棋盘按「行」存储：第 r 行第 c 列位于 words[r * words + (c >>> 5)] 的第 (c & 31) 位。
 * 行宽 w ≤ 32 时每行正好一个字；w ≤ 64 时每行两个字。
 * 全项目只有 Layout 知道这件事，其余模块一律按 Layout 计算偏移。
 */

export const WORD_BITS = 32;

/** 行宽上限。两个 32 位字，也就是 64。 */
export const MAX_SIDE = 64;

export interface Layout {
  /** 行数（长边）。 */
  readonly h: number;
  /** 列数（短边），即行宽。 */
  readonly w: number;
  /** 每行占几个 32 位字。 */
  readonly words: number;
  /** 最后一个字的有效位掩码。 */
  readonly lastMask: number;
  /** 整盘的字数 h * words，避免到处重算。 */
  readonly size: number;
}

export function layout(h: number, w: number): Layout {
  if (!Number.isInteger(h) || !Number.isInteger(w) || h < 1 || w < 1) {
    throw new Error(`棋盘尺寸必须是正整数，收到 ${h}×${w}`);
  }
  const words = (w + WORD_BITS - 1) >>> 5;
  const rest = w & (WORD_BITS - 1);
  return { h, w, words, lastMask: rest === 0 ? -1 : (1 << rest) - 1, size: h * words };
}

/** 32 位无符号整数的 popcount（SWAR，无查表，不触碰内存）。 */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** 32 位的奇偶性，等价于 popcount 的最低位。 */
export function parity32(x: number): number {
  return popcount32(x) & 1;
}

/** 平面上连续 count 个字的 1 的总数。 */
export function popcountWords(data: Uint32Array, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += popcount32(data[i]);
  return total;
}

/** 整盘点击总数。 */
export function popcountBoard(data: Uint32Array, l: Layout): number {
  return popcountWords(data, l.size);
}

/** 两个字向量的点积奇偶性，用于 GF(2) 的行运算。 */
export function dotParity(a: Uint32Array, aOff: number, b: Uint32Array, words: number): number {
  let acc = 0;
  for (let j = 0; j < words; j++) acc ^= a[aOff + j] & b[j];
  return parity32(acc);
}

export function rowIsZero(data: Uint32Array, off: number, words: number): boolean {
  for (let j = 0; j < words; j++) if (data[off + j] !== 0) return false;
  return true;
}

/** 抹掉最后一个字里超出 w 的位。 */
export function maskLast(data: Uint32Array, off: number, l: Layout): void {
  data[off + l.words - 1] &= l.lastMask;
}
