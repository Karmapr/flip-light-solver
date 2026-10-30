/**
 * 规范 §4.3 / §4.4：GF(2) 行最简形、行变换矩阵 E、零空间基。
 *
 * 矩阵是 w × w 的位矩阵，每行占 ceil(w/32) 个字。
 * 行交换与行异或必须对 R 和 E 同步执行 —— 一旦有一边漏掉，后面全是错的，
 * 而且错得很安静（解仍然合法，只是不是最优）。所以 §9.2 显式断言 R = E·M。
 */

import { layout, type Layout } from './bitset.ts';

export interface Rref {
  /** 行最简形，w 行 × words 字。 */
  readonly R: Uint32Array;
  /** 行变换矩阵，满足 R = E·M。 */
  readonly E: Uint32Array;
  /** 主元所在的列，长度等于 rank。 */
  readonly pivots: readonly number[];
  readonly rank: number;
}

function bitOf(data: Uint32Array, off: number, col: number): number {
  return (data[off + (col >>> 5)] >>> (col & 31)) & 1;
}

function xorRow(dst: Uint32Array, dstOff: number, src: Uint32Array, srcOff: number, words: number): void {
  for (let j = 0; j < words; j++) dst[dstOff + j] ^= src[srcOff + j];
}

function swapRow(data: Uint32Array, i: number, k: number, words: number): void {
  const a = i * words;
  const b = k * words;
  for (let j = 0; j < words; j++) {
    const t = data[a + j];
    data[a + j] = data[b + j];
    data[b + j] = t;
  }
}

/** 对 w × w 位矩阵做高斯—约当消元（原地复制，不改输入）。 */
export function rref(M: Uint32Array, w: number): Rref {
  const words = (w + 31) >>> 5;
  const R = new Uint32Array(M.subarray(0, w * words));
  const E = new Uint32Array(w * words);
  for (let i = 0; i < w; i++) E[i * words + (i >>> 5)] = 1 << (i & 31);

  const pivots: number[] = [];
  let rank = 0;

  for (let col = 0; col < w; col++) {
    let pivot = -1;
    for (let i = rank; i < w; i++) {
      if (bitOf(R, i * words, col) === 1) {
        pivot = i;
        break;
      }
    }
    if (pivot < 0) continue;

    if (pivot !== rank) {
      swapRow(R, rank, pivot, words);
      swapRow(E, rank, pivot, words);
    }
    for (let i = 0; i < w; i++) {
      if (i !== rank && bitOf(R, i * words, col) === 1) {
        xorRow(R, i * words, R, rank * words, words);
        xorRow(E, i * words, E, rank * words, words);
      }
    }
    pivots.push(col);
    rank++;
  }

  return { R, E, pivots, rank };
}

/**
 * 规范 §4.4：对每个自由列构造一个 M·z = 0 的基向量。
 * 返回 d × words 的扁平数组。
 */
export function nullspaceVectors(r: Rref, w: number): Uint32Array {
  const words = (w + 31) >>> 5;
  const isPivot = new Uint8Array(w);
  for (const p of r.pivots) isPivot[p] = 1;

  const free: number[] = [];
  for (let c = 0; c < w; c++) if (isPivot[c] === 0) free.push(c);

  const out = new Uint32Array(free.length * words);
  for (let k = 0; k < free.length; k++) {
    const f = free[k];
    const base = k * words;
    out[base + (f >>> 5)] |= 1 << (f & 31);
    for (let i = 0; i < r.rank; i++) {
      if (bitOf(r.R, i * words, f) === 1) {
        const p = r.pivots[i];
        out[base + (p >>> 5)] ^= 1 << (p & 31);
      }
    }
  }
  return out;
}

/** 校验 R = E·M（规范 §9.2 的断言，测试里也用它）。 */
export function verifyRowTransform(M: Uint32Array, r: Rref, w: number): boolean {
  const l: Layout = layout(w, w);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < w; j++) {
      let acc = 0;
      for (let k = 0; k < w; k++) {
        if (bitOf(r.E, i * l.words, k) === 1) acc ^= bitOf(M, k * l.words, j);
      }
      if (acc !== bitOf(r.R, i * l.words, j)) return false;
    }
  }
  return true;
}
