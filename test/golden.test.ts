/**
 * 规范 §9.2 / §9.3：代数恒等式与参考值。
 *
 * 本轮新增的重点是跨字边界：行宽超过 32 后，A(x) 需要跨字进位，
 * 这是整个多字行改写里唯一「写错了也能跑、但结果全错」的地方，
 * 所以用逐位朴素实现做独立基准逐宽度校验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { layout, popcount32, MAX_SIDE } from '../src/kernel/bitset.ts';
import { buildMatrix, prepare } from '../src/kernel/solve.ts';
import { nullspaceVectors, rref, verifyRowTransform } from '../src/kernel/field.ts';
import { applyClicks, chase, horizontalInto, invert, isGoal, transpose } from '../src/kernel/rules.ts';

function setBit(a: Uint32Array, i: number): void {
  a[i >>> 5] |= 1 << (i & 31);
}

function getBit(a: Uint32Array, i: number): number {
  return (a[i >>> 5] >>> (i & 31)) & 1;
}

/** 逐位朴素实现的 A(x)：不依赖任何位运算技巧。 */
function naiveHorizontal(bits: number[], w: number): number[] {
  const out = new Array<number>(w).fill(0);
  for (let c = 0; c < w; c++) {
    if (bits[c] === 0) continue;
    out[c] ^= 1;
    if (c > 0) out[c - 1] ^= 1;
    if (c + 1 < w) out[c + 1] ^= 1;
  }
  return out;
}

test('popcount32 与朴素计数一致', () => {
  for (let i = 0; i < 2000; i++) {
    const x = (Math.random() * 0x100000000) | 0;
    let expected = 0;
    for (let b = 0; b < 32; b++) if ((x >>> b) & 1) expected++;
    assert.equal(popcount32(x), expected, `x = ${x >>> 0}`);
  }
  assert.equal(popcount32(0), 0);
  assert.equal(popcount32(-1), 32);
});

test('A(x) 在所有行宽 1..64 上与逐位实现一致（跨字进位专项）', () => {
  for (let w = 1; w <= MAX_SIDE; w++) {
    const l = layout(3, w);
    const src = new Uint32Array(l.words);
    const dst = new Uint32Array(l.words);
    for (let trial = 0; trial < 40; trial++) {
      src.fill(0);
      const bits = new Array<number>(w);
      for (let c = 0; c < w; c++) {
        bits[c] = Math.random() < 0.5 ? 1 : 0;
        if (bits[c] === 1) setBit(src, c);
      }
      horizontalInto(src, 0, dst, 0, l);
      const want = naiveHorizontal(bits, w);
      for (let c = 0; c < w; c++) {
        assert.equal(getBit(dst, c), want[c]!, `w=${w} 第 ${c} 位`);
      }
      // 超出 w 的位必须为 0
      for (let c = w; c < l.words * 32; c++) {
        assert.equal(getBit(dst, c), 0, `w=${w} 第 ${c} 位越界非零`);
      }
    }
  }
});

test('规范 §9.3 的零空间维数参考值（含多字行尺寸）', () => {
  const reference: Array<[number, number]> = [
    [4, 4],
    [5, 2],
    [9, 8],
    [19, 16],
    [30, 20],
    [39, 32],
    [47, 30],
    [61, 40],
    [64, 28],
  ];
  for (const [size, expected] of reference) {
    const g = prepare(size, size);
    assert.equal(g.nullity, expected, `${size}×${size} 的 d`);
    assert.equal(g.rank + g.nullity, size, `${size}×${size} 的 rank + d = w`);
  }
  assert.equal(MAX_SIDE, 64);
});

test('行最简形满足 R = E·M（含 w > 32）', () => {
  for (const [h, w] of [[4, 4], [7, 3], [12, 5], [30, 30], [33, 33], [40, 34], [64, 64]] as Array<[number, number]>) {
    const M = buildMatrix(h, w);
    const r = rref(M, w);
    assert.ok(verifyRowTransform(M, r, w), `${h}×${w} 的 R ≠ E·M`);

    let seen = -1;
    for (let i = 0; i < r.rank; i++) {
      let first = -1;
      for (let c = 0; c < w; c++) if (getBit(r.R.subarray(i * layout(w, w).words), c) === 1) { first = c; break; }
      assert.ok(first > seen, `${h}×${w} 主元顺序`);
      seen = first;
    }
    for (let i = r.rank; i < w; i++) {
      let any = false;
      for (let j = 0; j < layout(w, w).words; j++) if (r.R[i * layout(w, w).words + j] !== 0) any = true;
      assert.equal(any, false, `${h}×${w} 第 ${i} 行应为零行`);
    }
  }
});

test('零空间基满足 M·z = 0，且在全灭棋盘上追灯残留为 0', () => {
  for (const [h, w] of [[4, 4], [9, 9], [30, 30], [33, 33], [39, 39]] as Array<[number, number]>) {
    const lw = layout(w, w);
    const lb = layout(h, w);
    const M = buildMatrix(h, w);
    const vectors = nullspaceVectors(rref(M, w), w);
    const zeros = new Uint32Array(lb.size);
    const clicks = new Uint32Array(lb.size);
    const residue = new Uint32Array(lb.words);
    const top = new Uint32Array(lb.words);

    for (let k = 0; k < vectors.length / lw.words; k++) {
      // M·z 的每一位都必须为 0
      for (let r = 0; r < w; r++) {
        let acc = 0;
        for (let j = 0; j < lw.words; j++) acc ^= M[r * lw.words + j] & vectors[k * lw.words + j];
        assert.equal(popcount32(acc) & 1, 0, `${h}×${w} 的基向量 ${k} 在行 ${r} 上不为零`);
      }
      top.set(vectors.subarray(k * lw.words, (k + 1) * lw.words));
      chase(top, zeros, lb, clicks, residue);
      for (let j = 0; j < lb.words; j++) assert.equal(residue[j], 0, `${h}×${w} 基向量追灯残留非零`);
      assert.ok(isGoal(applyClicks(zeros, clicks, lb), lb, false));
    }
  }
});

test('1×1 与 1×W 的边界', () => {
  const l = layout(1, 1);
  const lit = new Uint32Array([1]);
  const clicks = new Uint32Array(1);
  const residue = new Uint32Array(1);

  chase(new Uint32Array(1), lit, l, clicks, residue);
  assert.equal(residue[0], 1, '亮一格的 1×1 追灯后残留应为 1');

  chase(new Uint32Array([1]), lit, l, clicks, residue);
  assert.equal(residue[0], 0);
  assert.equal(clicks[0], 1);
  assert.equal(prepare(1, 1).nullity, 0);
});

test('转置不改变结构，跨字尺寸也能转回自身', () => {
  for (const [H, W] of [[3, 5], [5, 3], [40, 3], [3, 40], [33, 5]] as Array<[number, number]>) {
    const l = layout(H, W);
    const board = new Uint32Array(l.size);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (Math.random() < 0.5) board[r * l.words + (c >>> 5)] |= 1 << (c & 31);
      }
    }
    const flipped = transpose(board, H, W);
    const back = transpose(flipped, W, H);
    assert.deepEqual(Array.from(back), Array.from(board), `${H}×${W} 转置两次`);
  }
});

test('同一格点击两次恢复原状', () => {
  const l = layout(4, 4);
  const board = new Uint32Array([0b1010, 0b0101, 0b1111, 0b0000]);
  const once = new Uint32Array([0b0100, 0, 0, 0]);
  const twice = new Uint32Array([0, 0, 0, 0]);
  const a = applyClicks(board, once, l);
  const b = applyClicks(a, once, l);
  assert.deepEqual(Array.from(b), Array.from(board));
  assert.deepEqual(Array.from(applyClicks(board, twice, l)), Array.from(board));
});

test('全亮与全灭互为取反，isGoal 认得出两种目标', () => {
  const l = layout(9, 6);
  const board = new Uint32Array(l.size);
  assert.ok(isGoal(board, l, false));
  assert.ok(!isGoal(board, l, true));

  const full = invert(board, l);
  assert.ok(isGoal(full, l, true));
  assert.ok(!isGoal(full, l, false));
  assert.deepEqual(Array.from(invert(full, l)), Array.from(board));
});
