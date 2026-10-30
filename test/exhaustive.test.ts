/**
 * 规范 §9.1：穷举对照。
 *
 * 对每个 H·W ≤ 12 的尺寸，遍历全部 2^(H·W) 个初始盘面，
 * 与独立的暴力基准逐项比对：可解性、最少点击数、解的总数。
 *
 * 基准的构造方式刻意与求解器无关：直接枚举全部点击位图，
 * 用 applyClicks 正向模拟，得到「盘面 -> 最少点击数/解个数」的查找表。
 *
 * 这是整个项目唯一的安全网：内核改成多字行之后，这份测试必须原样通过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { layout, popcount32 } from '../src/kernel/bitset.ts';
import { applyClicks, clicksToBoardSpace, isGoal, toCanonical } from '../src/kernel/rules.ts';
import { prepare, solveBoard, type Geometry } from '../src/kernel/solve.ts';

const MAX_CELLS = 12;

function toRows(state: number, H: number, W: number): Uint32Array {
  const l = layout(H, W);
  const rows = new Uint32Array(l.size);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if ((state >>> (r * W + c)) & 1) rows[r * l.words + (c >>> 5)] |= 1 << (c & 31);
    }
  }
  return rows;
}

function fromRows(rows: Uint32Array, H: number, W: number): number {
  const l = layout(H, W);
  let state = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if ((rows[r * l.words + (c >>> 5)] >>> (c & 31)) & 1) state |= 1 << (r * W + c);
    }
  }
  return state >>> 0;
}

interface Truth {
  readonly minClicks: number;
  readonly solutions: number;
}

function buildOracle(H: number, W: number): Map<number, Truth> {
  const cells = H * W;
  const l = layout(H, W);
  const zeros = new Uint32Array(l.size);
  const oracle = new Map<number, Truth>();

  for (let pattern = 0; pattern < 1 << cells; pattern++) {
    const clicks = toRows(pattern, H, W);
    const board = applyClicks(zeros, clicks, l);
    const key = fromRows(board, H, W);
    const cost = popcount32(pattern);

    const current = oracle.get(key);
    if (current === undefined) {
      oracle.set(key, { minClicks: cost, solutions: 1 });
    } else {
      oracle.set(key, {
        minClicks: Math.min(current.minClicks, cost),
        solutions: current.solutions + 1,
      });
    }
  }
  return oracle;
}

test(`全部 ${MAX_CELLS} 格以内尺寸的穷举对照`, { timeout: 600_000 }, () => {
  const geometries = new Map<string, Geometry>();
  const geometryFor = (h: number, w: number): Geometry => {
    const key = `${h}x${w}`;
    let g = geometries.get(key);
    if (g === undefined) {
      g = prepare(h, w);
      geometries.set(key, g);
    }
    return g;
  };

  let checked = 0;

  for (let H = 1; H <= MAX_CELLS; H++) {
    for (let W = 1; H * W <= MAX_CELLS; W++) {
      const cells = H * W;
      const oracle = buildOracle(H, W);
      const boardLayout = layout(H, W);

      for (let state = 0; state < 1 << cells; state++) {
        const lights = toRows(state, H, W);
        const canonical = toCanonical(lights, H, W);
        const geometry = geometryFor(canonical.l.h, canonical.l.w);
        const result = solveBoard(canonical.rows, geometry);
        const truth = oracle.get(state);

        if (truth === undefined) {
          assert.equal(result.status, 'UNSOLVABLE', `${H}×${W} 状态 ${state} 应为无解`);
          assert.equal(result.solutionCount, 0);
          assert.equal(result.clicks, null);
          continue;
        }

        assert.equal(result.status, 'OPTIMAL', `${H}×${W} 状态 ${state} 应有解`);
        assert.equal(result.clickCount, truth.minClicks, `${H}×${W} 状态 ${state} 的最少点击数`);
        assert.equal(result.solutionCount, truth.solutions, `${H}×${W} 状态 ${state} 的解总数`);

        // 方案必须真的让棋盘全灭，且点击数统计一致
        const inBoardSpace = clicksToBoardSpace(result.clicks!, canonical);
        const after = applyClicks(lights, inBoardSpace, boardLayout);
        assert.ok(isGoal(after, boardLayout, false), `${H}×${W} 状态 ${state} 的方案未使棋盘全灭`);

        let counted = 0;
        for (let i = 0; i < boardLayout.size; i++) counted += popcount32(inBoardSpace[i]);
        assert.equal(counted, result.clickCount, `${H}×${W} 状态 ${state} 的点击数`);

        checked++;
      }
    }
  }

  assert.ok(checked > 10_000, `实际校验的盘面数偏少：${checked}`);
  console.log(`\n穷举对照：35 个尺寸，共校验 ${checked.toLocaleString('en-US')} 个有解盘面（无解盘面另计）\n`);
});
