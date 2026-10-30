/**
 * 十字翻转规则与「追灯」递推。
 *
 * 对应规范 §1（规则）、§3（chase）、§9.2（独立校验）。
 * 与规范唯一的形式差异：棋盘按行存成 Uint32Array，行宽 up to 64 时每行两个字。
 *
 * A(x) 是这里唯一需要跨字进位的地方：
 *   左移一位时，第 j 个字的最高位要落到第 j+1 个字的最低位；
 *   右移一位时，第 j+1 个字的最低位要落到第 j 个字的最高位。
 * 位序错一位，全盘皆错且肉眼看不出来 —— 所以 golden 测试专门守这一处。
 */

import { layout, maskLast, type Layout } from './bitset.ts';

/** A(x)：只影响同一行的部分。等价于「点击本行 x 里所有格」造成的水平翻转。 */
export function horizontalInto(
  src: Uint32Array,
  srcOff: number,
  dst: Uint32Array,
  dstOff: number,
  l: Layout,
): void {
  const words = l.words;
  for (let j = 0; j < words; j++) {
    const cur = src[srcOff + j];
    const shl = (cur << 1) | (j > 0 ? src[srcOff + j - 1] >>> 31 : 0);
    const shr = (cur >>> 1) | (j + 1 < words ? src[srcOff + j + 1] << 31 : 0);
    dst[dstOff + j] = (cur ^ shl ^ shr) & (j === words - 1 ? l.lastMask : -1);
  }
}

/**
 * 给定第一行点击 top，向下追灯。
 *
 * top / residue 长度均为 words，是一条行向量。
 * clicks 长度 h * words，存放每一行的点击位。
 * 返回的残留不是「可以点击的第 h 行」：只有残留全零时 clicks 才是有效解。
 */
export function chase(
  top: Uint32Array,
  lights: Uint32Array,
  l: Layout,
  clicks: Uint32Array,
  residue: Uint32Array,
): void {
  const words = l.words;
  const prev = new Uint32Array(words);
  const curr = new Uint32Array(words);
  const next = new Uint32Array(words);

  for (let j = 0; j < words; j++) curr[j] = top[j];
  maskLast(curr, 0, l);

  for (let r = 0; r < l.h; r++) {
    clicks.set(curr, r * words);
    horizontalInto(curr, 0, next, 0, l);
    const base = r * words;
    for (let j = 0; j < words; j++) next[j] ^= lights[base + j] ^ prev[j];
    maskLast(next, 0, l);
    prev.set(curr);
    curr.set(next);
  }
  residue.set(curr);
}

/**
 * 独立于求解器的规则模拟，专门用来校验求解结果。
 * 刻意不复用 chase —— 校验器和被校验对象必须走两条路径。
 */
export function applyClicks(
  lights: Uint32Array,
  clicks: Uint32Array,
  l: Layout,
): Uint32Array {
  const words = l.words;
  const out = new Uint32Array(l.size);
  out.set(lights.subarray(0, l.size));

  const tmp = new Uint32Array(words);
  for (let r = 0; r < l.h; r++) {
    const base = r * words;
    horizontalInto(clicks, base, tmp, 0, l);
    for (let j = 0; j < words; j++) {
      let v = out[base + j] ^ tmp[j];
      if (r > 0) v ^= clicks[base - words + j];
      if (r + 1 < l.h) v ^= clicks[base + words + j];
      out[base + j] = v;
    }
    maskLast(out, base, l);
  }
  return out;
}

/** 整盘是否处于目标态：全灭（on=false）或全亮（on=true）。 */
export function isGoal(board: Uint32Array, l: Layout, on: boolean): boolean {
  const words = l.words;
  // 注意：Uint32Array 读出来是无符号数，掩码结果必须先 >>> 0，
  // 否则 -1 与 4294967295 比较永远不相等（全亮目标会静默失效）。
  const fill = on ? -1 : 0;
  const whole = fill >>> 0;
  const last = (fill & l.lastMask) >>> 0;
  for (let r = 0; r < l.h; r++) {
    const base = r * words;
    for (let j = 0; j < words; j++) {
      if (board[base + j] !== (j === words - 1 ? last : whole)) return false;
    }
  }
  return true;
}

/** 逐位取反（用于把「解到全亮」化成「解到全灭」）。 */
export function invert(board: Uint32Array, l: Layout): Uint32Array {
  const out = new Uint32Array(l.size);
  for (let r = 0; r < l.h; r++) {
    const base = r * l.words;
    for (let j = 0; j < l.words; j++) out[base + j] = ~board[base + j];
    maskLast(out, base, l);
  }
  return out;
}

/** 把 fromH × fromW 的棋盘转置成 fromW × fromH。 */
export function transpose(data: Uint32Array, fromH: number, fromW: number): Uint32Array {
  const from = layout(fromH, fromW);
  const to = layout(fromW, fromH);
  const out = new Uint32Array(to.size);
  for (let r = 0; r < fromH; r++) {
    const base = r * from.words;
    for (let c = 0; c < fromW; c++) {
      if ((data[base + (c >>> 5)] >>> (c & 31)) & 1) {
        out[c * to.words + (r >>> 5)] |= 1 << (r & 31);
      }
    }
  }
  return out;
}

export interface Canonical {
  /** 求解器使用的布局：h 是长边，w 是短边。 */
  readonly l: Layout;
  readonly rows: Uint32Array;
  readonly transposed: boolean;
}

/**
 * 规范 §2：让「第一行」沿短边。
 * 十字规则在转置下不变，但自由变量数量等于短边长度，转置能压缩矩阵规模。
 */
export function toCanonical(lights: Uint32Array, H: number, W: number): Canonical {
  if (H >= W) return { l: layout(H, W), rows: lights, transposed: false };
  return { l: layout(W, H), rows: transpose(lights, H, W), transposed: true };
}

/** 把求解器给的点击方案转回用户棋盘的朝向。 */
export function clicksToBoardSpace(clicks: Uint32Array, c: Canonical): Uint32Array {
  return c.transposed ? transpose(clicks, c.l.h, c.l.w) : clicks;
}
