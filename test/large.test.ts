/**
 * 多字行在真实尺寸上的正确性与时间预算。
 *
 * 核心手段：挑 d = 0 的尺寸 —— 这时解唯一，所以求解器返回的点击方案
 * 必须与「生成这张盘面时所用的点击图案」逐位相同。
 * 这比「只要解合法」强得多：它同时验证了 M 的构造、消元、特解追灯、
 * 以及跨字进位的位序，而且不需要任何额外的参考实现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { layout, popcountBoard, popcount32 } from '../src/kernel/bitset.ts';
import { applyClicks, invert, isGoal } from '../src/kernel/rules.ts';
import { prepare, solveBoard, type Geometry } from '../src/kernel/solve.ts';

function randomBoard(h: number, w: number, seed: number): { lights: Uint32Array; clicks: Uint32Array } {
  const l = layout(h, w);
  const clicks = new Uint32Array(l.size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < l.size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    clicks[i] = x;
  }
  for (let r = 0; r < l.h; r++) clicks[r * l.words + l.words - 1] &= l.lastMask;
  const zeros = new Uint32Array(l.size);
  return { lights: applyClicks(zeros, clicks, l), clicks };
}

/** 用点击图案的补集再点一遍，得到「反相」盘面，避免出现全灭这种退化输入。 */
function nonTrivial(board: Uint32Array, h: number, w: number, seed: number): Uint32Array {
  const l = layout(h, w);
  const extra = new Uint32Array(l.size);
  let x = (seed * 2654435761) >>> 0 || 7;
  for (let i = 0; i < l.size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    extra[i] = x;
  }
  for (let r = 0; r < l.h; r++) extra[r * l.words + l.words - 1] &= l.lastMask;
  return applyClicks(board, extra, l);
}

const ZERO_D_SQUARES: Array<[number, number]> = [
  [40, 40],
  [48, 48],
  [56, 56],
  [60, 60],
];

test('d = 0 的大尺寸：解唯一，返回的点击方案必须逐位等于生成图案', { timeout: 120_000 }, () => {
  for (const [H, W] of ZERO_D_SQUARES) {
    const g = prepare(H, W);
    assert.equal(g.nullity, 0, `${H}×${W} 的 d 应为 0`);

    // 盘面由 clicks 点出来，那么唯一解就是 clicks 本身
    const l = layout(H, W);
    const { clicks } = randomBoard(H, W, H * 131 + W);
    const pure = applyClicks(new Uint32Array(l.size), clicks, l);

    const result = solveBoard(pure, g);
    assert.equal(result.status, 'OPTIMAL', `${H}×${W} 应当可证最优`);
    assert.equal(result.clickCount, popcountBoard(clicks, l));
    assert.deepEqual(Array.from(result.clicks!), Array.from(clicks), `${H}×${W} 的唯一解不一致`);

    // 再叠加一轮随机点击，让解不再是「刚生成的那一份」
    const other = nonTrivial(pure, H, W, 99);
    const second = solveBoard(other, g);
    assert.equal(second.status, 'OPTIMAL');
    assert.ok(isGoal(applyClicks(other, second.clicks!, l), l, false));
  }
});

test('跨字尺寸（w = 33 / 40）也能精确求解并重放验证', { timeout: 120_000 }, () => {
  for (const [H, W] of [[33, 33], [40, 33], [64, 40]] as Array<[number, number]>) {
    const g = prepare(H, W);
    const l = layout(H, W);
    const { lights } = randomBoard(H, W, H + W * 17);
    const result = solveBoard(lights, g, { timeLimitMs: 20_000 });

    assert.ok(result.solvable, `${H}×${W} 应当可解`);
    assert.equal(result.status, 'OPTIMAL', `${H}×${W} 应当在预算内证明最优`);
    assert.ok(isGoal(applyClicks(lights, result.clicks!, l), l, false), `${H}×${W} 方案无效`);

    let counted = 0;
    for (let i = 0; i < l.size; i++) counted += popcount32(result.clicks![i]);
    assert.equal(counted, result.clickCount);
  }
});

test('目标为全亮：等价于把盘面取反后解到全灭', { timeout: 60_000 }, () => {
  const H = 40;
  const W = 40;
  const g = prepare(H, W);
  const l = layout(H, W);
  const { lights } = randomBoard(H, W, 4242);

  const target = invert(lights, l);
  const result = solveBoard(target, g);
  assert.equal(result.status, 'OPTIMAL');
  assert.ok(isGoal(applyClicks(lights, result.clicks!, l), l, true), '未能解到全亮');
});

test('时间预算耗尽时返回可行解并标记未证明，绝不含糊地标最优', { timeout: 120_000 }, () => {
  const H = 39;
  const W = 39;
  const g = prepare(H, W);
  const l = layout(H, W);
  assert.equal(g.nullity, 32, '39×39 的 d 应为 32，2^32 不可能在 30ms 内枚举完');

  const { lights } = randomBoard(H, W, 777);
  const result = solveBoard(lights, g, { timeLimitMs: 30 });

  assert.equal(result.status, 'FEASIBLE_UNPROVEN');
  assert.equal(result.optimalProven, false);
  assert.equal(result.timedOut, true);
  assert.ok(result.checked < result.total, '中断时不应声称检查完全部组合');
  // 但解本身必须是真的
  assert.ok(isGoal(applyClicks(lights, result.clicks!, l), l, false), '超时返回的方案无效');
});

test('组合预算耗尽同样标记未证明，且状态诚实', { timeout: 60_000 }, () => {
  const g = prepare(30, 30);
  const l = layout(30, 30);
  assert.equal(g.nullity, 20);

  const { lights } = randomBoard(30, 30, 2024);
  const result = solveBoard(lights, g, { maxIterations: 1000 });
  assert.equal(result.status, 'FEASIBLE_UNPROVEN');
  assert.equal(result.checked, 1000);
  assert.ok(isGoal(applyClicks(lights, result.clicks!, l), l, false));
});
