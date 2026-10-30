/**
 * 会话状态机测试（不涉及 DOM）。
 *
 * 这里守的是整个交互设计里最关键的那条规则：
 *   每点一格 x：盘面 ^= cross(x)，方案 ^= {x}
 * 于是「点对」和「点错」走同一条代码路径，只是后者在视觉上变成红色。
 *
 * 由此得到两个可以断言的不变量：
 *   1. 方案始终是当前盘面的合法解（按标记点完一定能到目标态）
 *   2. 已点 + 还需 = 原最优 + 2 × 点错的格子数
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { layout, popcountBoard } from '../src/kernel/bitset.ts';
import { applyClicks, clicksToBoardSpace, invert, isGoal, toCanonical } from '../src/kernel/rules.ts';
import { prepare, solveBoard } from '../src/kernel/solve.ts';
import { Session } from '../src/ui/state.ts';
import type { SerializedResult } from '../src/solver.worker.ts';

/** 在本地同步求解，模拟 Worker 的行为（含转置与「解到全亮」的取反）。 */
function solveNow(s: Session): SerializedResult {
  const request = s.beginSolve();
  assert.ok(request !== null, '应当能发起求解');

  const l = layout(request.H, request.W);
  const toOn = request.goal === 'on';
  const target = toOn ? invert(request.lights, l) : request.lights;

  const c = toCanonical(target, request.H, request.W);
  const g = prepare(c.l.h, c.l.w);
  const raw = solveBoard(c.rows, g);
  const clicks = raw.clicks === null ? null : clicksToBoardSpace(raw.clicks, c);

  return { ...raw, clicks, elapsedMs: 0 } as SerializedResult;
}

function planCells(s: Session, plan: Uint32Array): Array<[number, number]> {
  const l = layout(s.H, s.W);
  const out: Array<[number, number]> = [];
  for (let r = 0; r < s.H; r++) {
    for (let c = 0; c < s.W; c++) {
      if ((plan[r * l.words + (c >>> 5)] >>> (c & 31)) & 1) out.push([r, c]);
    }
  }
  return out;
}

test('设置模式点一格只翻一格，游戏模式翻十字', () => {
  const s = new Session();
  s.resize(5, 5);
  s.setMode('setup');
  s.click(2, 2);
  assert.equal(s.lights[2], 1 << 2);

  s.setMode('game');
  s.click(0, 0);
  assert.equal(s.lights[0] & 0b11, 0b11, '左上角点击应翻 (0,0) 与 (0,1)');
  assert.equal(s.lights[1] & 1, 1, '应翻到下一行同列');
});

test('求解后进入引导，按标记点完必定达标', () => {
  const s = new Session();
  s.resize(6, 6);
  s.setMode('game');
  s.click(1, 1);
  s.click(4, 2);
  assert.equal(s.phase, 'ready');

  const raw = solveNow(s);
  assert.equal(raw.solvable, true);
  assert.equal(s.acceptResult(s.epoch, raw), true);
  assert.equal(s.phase, 'guiding');
  assert.equal(s.mode, 'game', '求解后应自动进入游戏模式');
  assert.equal(s.remaining, raw.clickCount);
  assert.equal(s.optimumClicks, raw.clickCount);

  for (const [r, c] of planCells(s, raw.clicks!)) s.click(r, c);

  assert.equal(s.phase, 'done');
  assert.ok(isGoal(s.lights, layout(6, 6), false), '点完标记后棋盘应当全灭');
});

test('点错会让那格变红，再点一次即撤回，且总次数恰好多 2', () => {
  const s = new Session();
  s.resize(6, 6);
  s.setMode('game');
  s.click(2, 3);

  const raw = solveNow(s);
  s.acceptResult(s.epoch, raw);
  const optimum = raw.clickCount!;

  const inPlan = new Set(planCells(s, raw.clicks!).map(([r, c]) => `${r},${c}`));
  let wrong: [number, number] | null = null;
  for (let r = 0; r < 6 && wrong === null; r++) {
    for (let c = 0; c < 6; c++) {
      if (!inPlan.has(`${r},${c}`)) {
        wrong = [r, c];
        break;
      }
    }
  }
  assert.ok(wrong !== null, '应当存在方案外的格子');

  s.click(wrong[0], wrong[1]);
  assert.equal(s.cellState(wrong[0], wrong[1]).mark, 'wrong', '点错的格子应当被标成红色');
  assert.equal(s.wrong, 1);
  assert.equal(s.used + s.remaining, optimum + 2);

  // 再点一次：撤回这步，格子回到无标记
  s.click(wrong[0], wrong[1]);
  assert.equal(s.cellState(wrong[0], wrong[1]).mark, 'none');
  assert.equal(s.wrong, 0);
  assert.equal(s.remaining, optimum);
  assert.equal(s.used + s.remaining, optimum + 2, '两次白点等于多花 2 次');

  // 走完剩下的标记，仍然能达标
  for (const [r, c] of planCells(s, s.planBits!)) s.click(r, c);
  assert.equal(s.phase, 'done');
  assert.ok(isGoal(s.lights, layout(6, 6), false));
});

test('点中方案里的格子让剩余数减一，且不产生红色', () => {
  const s = new Session();
  s.resize(4, 4);
  s.setMode('game');
  s.click(0, 0);

  const raw = solveNow(s);
  s.acceptResult(s.epoch, raw);
  const initial = s.remaining;
  assert.ok(initial > 0);

  const [r, c] = planCells(s, raw.clicks!)[0]!;
  s.click(r, c);
  assert.equal(s.remaining, initial - 1);
  assert.equal(s.wrong, 0);
});

test('目标为全亮时，按标记点完会全部点亮；切回全灭会作废方案', () => {
  const s = new Session();
  s.resize(5, 7);
  s.setGoal('on');
  s.setMode('game');
  s.click(1, 2);

  const raw = solveNow(s);
  assert.equal(raw.solvable, true);
  s.acceptResult(s.epoch, raw);
  assert.equal(s.phase, 'guiding');

  for (const [r, c] of planCells(s, raw.clicks!)) s.click(r, c);
  assert.equal(s.phase, 'done');
  assert.ok(isGoal(s.lights, layout(5, 7), true), '应当全部点亮');

  s.setGoal('off');
  assert.equal(s.phase, 'ready');
  assert.equal(s.remaining, 0);
});

test('随机可解盘面按当前目标生成，且真的可解', () => {
  for (const goal of ['off', 'on'] as const) {
    const s = new Session();
    s.resize(9, 9);
    s.setGoal(goal);
    s.randomSolvable();

    const raw = solveNow(s);
    assert.equal(raw.status, 'OPTIMAL', `${goal} 目标的随机盘面应当可解`);
    assert.ok(
      isGoal(applyClicks(s.lights, raw.clicks!, layout(9, 9)), layout(9, 9), goal === 'on'),
    );
  }
});

test('引导阶段切回设置模式会作废方案，之后点格子只翻自身', () => {
  const s = new Session();
  s.resize(5, 5);
  s.setMode('game');
  s.click(1, 1);

  const raw = solveNow(s);
  s.acceptResult(s.epoch, raw);
  assert.equal(s.phase, 'guiding');

  s.setMode('setup');
  assert.equal(s.phase, 'ready');
  assert.equal(s.remaining, 0);

  const before = s.lights[2];
  s.click(2, 2);
  assert.equal(s.lights[2], before ^ (1 << 2));
});

test('无解盘面不会进入引导，而是回到可编辑状态', () => {
  const s = new Session();
  s.resize(2, 1);
  s.lights = new Uint32Array([1, 0]);
  s.setMode('game');

  const raw = solveNow(s);
  assert.equal(raw.solvable, false);
  s.acceptResult(s.epoch, raw);
  assert.equal(s.phase, 'ready');
  assert.equal(s.panel().kind, 'unsolvable');
  assert.equal(popcountBoard(s.lights, layout(2, 1)) >= 0, true);
});

test('无解时恢复到求解前的模式，不硬切到游戏模式', () => {
  const s = new Session();
  s.resize(2, 1);
  s.lights = new Uint32Array([1, 0]);
  s.setMode('setup');

  const raw = solveNow(s);
  assert.equal(raw.solvable, false);
  s.acceptResult(s.epoch, raw);

  assert.equal(s.mode, 'setup', '从设置模式求解无解盘面后，应回到设置模式');
  assert.equal(s.phase, 'ready');
});
