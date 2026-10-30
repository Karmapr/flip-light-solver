/**
 * 规范 §5.1：格雷码枚举，外加「没时间证明最优」时用的下降搜索。
 *
 * 关键性质（任意切分的地基）：
 *   索引 k 处的点击位图 = C0 ⊕ (⋁ 满足 gray(k) 第 i 位为 1 的 B[i])
 *
 * 因此任意起点都能用 O(d) 次异或直接定位，不必从 0 跑到 k。
 *
 * 时间预算是这一层唯一的状态：每检查 8192 个组合看一次表，
 * 超时就带着当前最好解返回，并如实标记「未完成」。
 */

import { popcount32, popcountWords, type Layout } from './bitset.ts';

export interface Incumbent {
  cost: number;
  state: Uint32Array;
}

export interface EnumerateOutcome {
  /** 实际检查过的组合数。 */
  readonly checked: number;
  /** 是否把 [from, to) 全部走完。false 表示被时间预算中断。 */
  readonly completed: boolean;
}

const CHECK_INTERVAL = 8191;

function stateAtIndex(
  C0: Uint32Array,
  basis: Uint32Array,
  size: number,
  k: number,
  out: Uint32Array,
): void {
  out.set(C0);
  let gray = (k ^ (k >>> 1)) >>> 0;
  while (gray !== 0) {
    const bit = 31 - Math.clz32(gray);
    const base = bit * size;
    for (let i = 0; i < size; i++) out[i] ^= basis[base + i];
    gray &= gray - 1;
  }
}

/**
 * 枚举 t ∈ [from, to) 对应的全部有效点击方案，把更优者写入 best。
 * deadline 是 performance.now() 的绝对时刻，Infinity 表示不限时。
 */
export function enumerateRange(
  C0: Uint32Array,
  basis: Uint32Array,
  l: Layout,
  from: number,
  to: number,
  best: Incumbent,
  work: Uint32Array,
  deadline: number,
): EnumerateOutcome {
  const size = l.size;
  if (from >= to) return { checked: 0, completed: true };

  stateAtIndex(C0, basis, size, from, work);

  let checked = 0;
  let cost = popcountWords(work, size);
  if (cost < best.cost) {
    best.cost = cost;
    best.state.set(work);
  }
  checked++;

  let prevGray = (from ^ (from >>> 1)) >>> 0;
  let completed = true;

  for (let k = from + 1; k < to; k++) {
    if ((k & CHECK_INTERVAL) === 0 && performance.now() > deadline) {
      completed = false;
      break;
    }
    const gray = (k ^ (k >>> 1)) >>> 0;
    const base = (31 - Math.clz32(gray ^ prevGray)) * size;

    // 异或与 popcount 合成一趟，避免两次遍历
    let c = 0;
    for (let i = 0; i < size; i++) {
      const v = work[i] ^ basis[base + i];
      work[i] = v;
      c += popcount32(v);
    }

    if (c < best.cost) {
      best.cost = c;
      best.state.set(work);
    }

    prevGray = gray;
    checked++;
  }

  return { checked, completed };
}

/**
 * 单变量下降：只用于「没时间证明最优」时给一个不太差的可行上界。
 * 它不提供任何下界，因此调用方必须如实返回 FEASIBLE_UNPROVEN。
 */
export function localDescent(
  C0: Uint32Array,
  basis: Uint32Array,
  l: Layout,
  d: number,
): Incumbent {
  const size = l.size;
  const current = new Uint32Array(C0);
  const trial = new Uint32Array(size);
  let cost = popcountWords(current, size);

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < d; i++) {
      const base = i * size;
      let c = 0;
      for (let j = 0; j < size; j++) {
        const v = current[j] ^ basis[base + j];
        trial[j] = v;
        c += popcount32(v);
      }
      if (c < cost) {
        current.set(trial);
        cost = c;
        improved = true;
      }
    }
  }

  return { cost, state: current };
}

