/**
 * 规范 §4 + §6：几何预处理、线性判定、最优化的后端分派。
 *
 * 统一入口：
 *   prepare(h, w)               —— 与谜面无关的几何，按尺寸缓存一次
 *   solveBoard(lights, g, opt)  —— 每个谜面一次系数求解 + 有界的最优搜索
 *
 * 时间预算只影响「能否证明最优」，绝不影响「解的合法性」：
 * 超时返回的可行解同样经过重放校验，只是状态标为 FEASIBLE_UNPROVEN。
 */

import {
  dotParity,
  layout,
  MAX_SIDE,
  popcountBoard,
  rowIsZero,
  type Layout,
} from './bitset.ts';
import { chase, horizontalInto } from './rules.ts';
import { nullspaceVectors, rref } from './field.ts';
import { enumerateRange, localDescent, type Incumbent } from './gray.ts';

export type Status = 'UNSOLVABLE' | 'OPTIMAL' | 'FEASIBLE_UNPROVEN';

export interface Geometry {
  readonly l: Layout;
  readonly rank: number;
  readonly nullity: number;
  readonly pivots: readonly number[];
  readonly R: Uint32Array;
  readonly E: Uint32Array;
  /** d 个基，每个基是整盘点击位图，扁平存放：第 i 个基在 i * l.size。 */
  readonly basis: Uint32Array;
}

export interface SolveResult {
  readonly status: Status;
  readonly solvable: boolean;
  readonly optimalProven: boolean;
  /** 求解器行布局下的点击方案；无解为 null。 */
  readonly clicks: Uint32Array | null;
  readonly clickCount: number | null;
  readonly solutionCount: number;
  readonly rank: number;
  readonly nullity: number;
  readonly method: string;
  /** 实际检查过的组合数。 */
  readonly checked: number;
  /** 该尺寸下全部有效解的个数 2^d。 */
  readonly total: number;
  /** 是否因时间预算被中断。 */
  readonly timedOut: boolean;
}

export interface SolveOptions {
  /** 毫秒。0 或不设表示不限时。 */
  readonly timeLimitMs?: number;
  /** 组合数上限，用于测试中强制走「未证明」分支。 */
  readonly maxIterations?: number;
}

/**
 * 规范 §4.1：第一行点击到最后一行残留的线性映射 M（w×w）。
 * 第 c 列 = 在全灭棋盘上以 e_c 为第一行追灯 h 步后的残留。
 * 只跑递推，不构造完整点击位图。
 */
export function buildMatrix(h: number, w: number): Uint32Array {
  const l = layout(h, w);
  const words = l.words;
  const M = new Uint32Array(w * words);

  const prev = new Uint32Array(words);
  const curr = new Uint32Array(words);
  const next = new Uint32Array(words);

  for (let c = 0; c < w; c++) {
    prev.fill(0);
    curr.fill(0);
    curr[c >>> 5] = 1 << (c & 31);
    for (let i = 0; i < h; i++) {
      horizontalInto(curr, 0, next, 0, l);
      for (let j = 0; j < words; j++) next[j] ^= prev[j];
      next[words - 1] &= l.lastMask;
      prev.set(curr);
      curr.set(next);
    }
    const bit = 1 << (c & 31);
    const off = c >>> 5;
    for (let r = 0; r < w; r++) {
      if ((curr[r >>> 5] >>> (r & 31)) & 1) M[r * words + off] |= bit;
    }
  }
  return M;
}

/** 构造 M 并完成消元与零空间基。 */
export function prepare(h: number, w: number): Geometry {
  if (!Number.isInteger(h) || !Number.isInteger(w) || h < 1 || w < 1) {
    throw new Error(`棋盘尺寸必须是正整数，收到 ${h}×${w}`);
  }
  if (h < w) throw new Error('prepare 要求 h >= w，请先转置');
  if (w > MAX_SIDE) throw new Error(`行宽上限 ${MAX_SIDE}，收到 ${w}`);

  const l = layout(h, w);
  const r = rref(buildMatrix(h, w), w);
  const nullity = w - r.rank;
  const basis = new Uint32Array(nullity * l.size);

  if (nullity > 0) {
    const vectors = nullspaceVectors(r, w);
    const zeros = new Uint32Array(l.size);
    const clicks = new Uint32Array(l.size);
    const residue = new Uint32Array(l.words);
    const top = new Uint32Array(l.words);

    for (let i = 0; i < nullity; i++) {
      top.set(vectors.subarray(i * l.words, (i + 1) * l.words));
      chase(top, zeros, l, clicks, residue);
      if (!rowIsZero(residue, 0, l.words)) {
        throw new Error('内核错误：零空间基不应当改变终局');
      }
      basis.set(clicks, i * l.size);
    }
  }

  return { l, rank: r.rank, nullity, pivots: r.pivots, R: r.R, E: r.E, basis };
}

/**
 * 精确判定可解性并求全盘最小点击数。
 * lights 必须已经是规范布局（行沿长边），长度等于 h * words。
 */
export function solveBoard(
  lights: Uint32Array,
  g: Geometry,
  options: SolveOptions = {},
): SolveResult {
  const l = g.l;
  const { w, words } = l;
  const { rank, nullity } = g;

  if (lights.length !== l.size) {
    throw new Error(`棋盘长度应为 ${l.size} 个字，收到 ${lights.length}`);
  }

  // 规范 §4.2：residue(x, b) = s ⊕ Mx，其中 s 是零第一行时的残留
  const residue = new Uint32Array(words);
  const scratch = new Uint32Array(l.size);
  chase(new Uint32Array(words), lights, l, scratch, residue);

  // 规范 §4.3：可解 <=> 消元后零行对应的 (E·s) 位全为 0
  const y = new Uint8Array(w);
  for (let i = 0; i < w; i++) y[i] = dotParity(g.E, i * words, residue, words);

  for (let i = rank; i < w; i++) {
    if (y[i] === 1) {
      return {
        status: 'UNSOLVABLE',
        solvable: false,
        optimalProven: true,
        clicks: null,
        clickCount: null,
        solutionCount: 0,
        rank,
        nullity,
        method: 'linear',
        checked: 0,
        total: 0,
        timedOut: false,
      };
    }
  }

  // 自由变量全取 0 得到特解
  const x0 = new Uint32Array(words);
  for (let i = 0; i < rank; i++) {
    if (y[i] === 1) {
      const p = g.pivots[i];
      x0[p >>> 5] |= 1 << (p & 31);
    }
  }

  const C0 = new Uint32Array(l.size);
  chase(x0, lights, l, C0, residue);
  if (!rowIsZero(residue, 0, words)) {
    throw new Error('内核错误：特解未能使棋盘全灭');
  }

  const baseCost = popcountBoard(C0, l);
  const total = Math.pow(2, nullity);

  if (baseCost === 0 || nullity === 0) {
    return {
      status: 'OPTIMAL',
      solvable: true,
      optimalProven: true,
      clicks: C0,
      clickCount: baseCost,
      solutionCount: total,
      rank,
      nullity,
      method: nullity === 0 ? 'linear' : 'trivial',
      checked: 1,
      total: nullity === 0 ? 1 : total,
      timedOut: false,
    };
  }

  const limitMs = options.timeLimitMs ?? 0;
  const deadline = limitMs > 0 ? performance.now() + limitMs : Infinity;
  const maxIterations = options.maxIterations ?? Infinity;

  // 先拿一个便宜的上界，这样即使预算极小也有像样的可行解
  const best: Incumbent = localDescent(C0, g.basis, l, nullity);

  const span = Math.min(total, maxIterations);
  const work = new Uint32Array(l.size);
  const outcome = enumerateRange(C0, g.basis, l, 0, span, best, work, deadline);

  const proven = outcome.completed && span >= total;

  return {
    status: proven ? 'OPTIMAL' : 'FEASIBLE_UNPROVEN',
    solvable: true,
    optimalProven: proven,
    clicks: best.state,
    clickCount: best.cost,
    solutionCount: total,
    rank,
    nullity,
    method: proven ? 'gray' : outcome.checked > 0 ? 'gray-partial' : 'descent',
    checked: outcome.checked,
    total,
    timedOut: !outcome.completed,
  };
}
