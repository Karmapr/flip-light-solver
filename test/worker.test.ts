/**
 * Worker 冒烟测试。
 *
 * 前面的测试都直接调内核函数，这一份刻意跑构建产物 dist/，
 * 覆盖三件只有真实链路才会暴露的事：
 *   1. 转置（W > H 时）是否把答案正确转回用户朝向
 *   2. 消息协议、目标切换与 Transferable 是否成立
 *   3. 返回前的「原始规则重放」校验是否真的在跑
 *
 * 依赖 npm run build 先产出 dist/。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyClicks, isGoal } from '../dist/src/kernel/rules.js';
import { layout, popcountBoard } from '../dist/src/kernel/bitset.js';

interface Sent {
  message: Record<string, unknown>;
  transfer?: Transferable[];
}

const sent: Sent[] = [];
const scope: { postMessage: (m: unknown, t?: Transferable[]) => void; onmessage: ((e: unknown) => void) | null } = {
  postMessage(message, transfer) {
    sent.push({ message: message as Record<string, unknown>, transfer });
  },
  onmessage: null,
};

(globalThis as unknown as { self: unknown }).self = scope;

await import('../dist/src/solver.worker.js');

interface Serialized {
  status: string;
  clickCount: number | null;
  clicks: Uint32Array | null;
  solutionCount: number;
  nullity: number;
  optimalProven: boolean;
  timedOut: boolean;
  checked: number;
  total: number;
}

function call(H: number, W: number, lights: Uint32Array, goal: 'off' | 'on' = 'off', timeLimitMs = 0) {
  sent.length = 0;
  scope.onmessage!({ data: { id: 7, H, W, lights, goal, timeLimitMs } });
  assert.equal(sent.length, 1, 'Worker 应当恰好回一条消息');
  const message = sent[0].message as { id: number; ok: boolean; error?: string; result?: Serialized };
  assert.equal(message.id, 7);
  return message;
}

function solvable(H: number, W: number, seed: number): { lights: Uint32Array; clicks: Uint32Array } {
  const l = layout(H, W);
  const clicks = new Uint32Array(l.size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < l.size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    clicks[i] = x;
  }
  for (let r = 0; r < l.h; r++) clicks[r * l.words + l.words - 1] &= l.lastMask;
  return { lights: applyClicks(new Uint32Array(l.size), clicks, l), clicks };
}

test('Worker 在 H > W 时不需要转置', () => {
  const { lights } = solvable(6, 4, 12345);
  const message = call(6, 4, lights);
  assert.ok(message.ok, message.error);
  const result = message.result!;
  assert.equal(result.status, 'OPTIMAL');
  assert.ok(result.optimalProven);

  const l = layout(6, 4);
  const clicks = result.clicks!;
  assert.equal(clicks.length, l.size);
  assert.ok(isGoal(applyClicks(lights, clicks, l), l, false));
  assert.equal(popcountBoard(clicks, l), result.clickCount);
});

test('Worker 在 W > H 时转置求解并把答案转回原朝向', () => {
  const { lights } = solvable(4, 9, 999);
  const message = call(4, 9, lights);
  assert.ok(message.ok, message.error);
  const result = message.result!;
  assert.equal(result.status, 'OPTIMAL');

  const l = layout(4, 9);
  const clicks = result.clicks!;
  assert.equal(clicks.length, l.size);
  assert.ok(isGoal(applyClicks(lights, clicks, l), l, false));
  assert.equal(popcountBoard(clicks, l), result.clickCount);
});

test('Worker 支持解到全亮', () => {
  const { lights } = solvable(5, 7, 31415);
  const message = call(5, 7, lights, 'on');
  assert.ok(message.ok, message.error);
  const result = message.result!;
  assert.equal(result.status, 'OPTIMAL');

  const l = layout(5, 7);
  assert.ok(isGoal(applyClicks(lights, result.clicks!, l), l, true), '应当全部点亮');
});

test('Worker 对无解盘面返回 UNSOLVABLE 而不是超时降级', () => {
  // 2×1 且上方亮：两次点击都同时翻转两格，无法只灭一格
  const message = call(2, 1, new Uint32Array([1, 0]));
  assert.ok(message.ok, message.error);
  assert.equal(message.result!.status, 'UNSOLVABLE');
  assert.equal(message.result!.solutionCount, 0);
  assert.equal(message.result!.clicks, null);
});

test('全灭盘面零次点击即最优', () => {
  const message = call(7, 7, new Uint32Array(7));
  assert.ok(message.ok, message.error);
  const result = message.result!;
  assert.equal(result.status, 'OPTIMAL');
  assert.equal(result.clickCount, 0);
});

test('跨字尺寸经 Worker 链路仍然正确', () => {
  const { lights } = solvable(40, 40, 20261030);
  const message = call(40, 40, lights);
  assert.ok(message.ok, message.error);
  const result = message.result!;
  assert.equal(result.status, 'OPTIMAL');
  assert.equal(result.nullity, 0);
  assert.equal(result.total, 1);
});

test('Transferable 列表与实际返回的缓冲区一致', () => {
  const { lights } = solvable(5, 5, 42);
  const message = call(5, 5, lights);
  const result = message.result!;
  assert.equal(sent[0].transfer?.length, 1);
  assert.equal(sent[0].transfer![0], result.clicks!.buffer);
});
