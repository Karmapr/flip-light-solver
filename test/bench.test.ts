/**
 * 规范 §9.4：基准测试。
 *
 * 目的只有一个——回答「家用机能解多大的棋盘」。
 * 关键事实：难度由零空间维数 d 决定，而 d 不是尺寸的单调函数，
 * 所以「最大棋盘」不是一个数，而是一张按 d 分档的尺寸清单。
 *
 * 用 node --test test/bench.test.ts 运行，输出是一份报告而不是断言。
 */

import test from 'node:test';

import { layout, MAX_SIDE, type Layout } from '../src/kernel/bitset.ts';
import { applyClicks } from '../src/kernel/rules.ts';
import { prepare, solveBoard, type Geometry } from '../src/kernel/solve.ts';

const ITER_BUDGET = 1 << 22;

function solvableBoard(h: number, w: number, l: Layout): Uint32Array {
  const zeros = new Uint32Array(l.size);
  for (;;) {
    const clicks = new Uint32Array(l.size);
    for (let i = 0; i < l.size; i++) clicks[i] = (Math.random() * 0x100000000) | 0;
    for (let r = 0; r < h; r++) clicks[r * l.words + l.words - 1] &= l.lastMask;
    const board = applyClicks(zeros, clicks, l);
    let any = false;
    for (let i = 0; i < l.size; i++) if (board[i] !== 0) any = true;
    if (any) return board;
  }
}

test('全尺寸零空间维数与求解耗时', { timeout: 600_000 }, () => {
  const started = performance.now();

  // ---- 第一遍：所有尺寸的 d ----
  const byD = new Map<number, Array<[number, number]>>();
  const geometry = new Map<string, Geometry>();
  const key = (h: number, w: number): string => `${h}x${w}`;

  for (let H = 1; H <= MAX_SIDE; H++) {
    for (let W = 1; W <= MAX_SIDE; W++) {
      const h = Math.max(H, W);
      const w = Math.min(H, W);
      let g = geometry.get(key(h, w));
      if (g === undefined) {
        g = prepare(h, w);
        geometry.set(key(h, w), g);
      }
      const list = byD.get(g.nullity);
      if (list === undefined) byD.set(g.nullity, [[H, W]]);
      else list.push([H, W]);
    }
  }

  const geometryMs = performance.now() - started;
  const pairs = MAX_SIDE * MAX_SIDE;

  // ---- 第二遍：每个 d 取一个代表尺寸实测 ----
  const timings: Array<{ d: number; H: number; W: number; ms: number; count: number }> = [];

  for (const [d, sizes] of [...byD.entries()].sort((a, b) => a[0] - b[0])) {
    if (d === 0) continue;
    const count = Math.pow(2, d);
    if (count > ITER_BUDGET) continue;

    // 取面积最大者，代表该 d 下最坏的单次迭代成本
    const [H, W] = sizes.reduce((a, b) => (b[0] * b[1] > a[0] * a[1] ? b : a));
    const h = Math.max(H, W);
    const w = Math.min(H, W);
    const g = geometry.get(key(h, w))!;
    const l = layout(h, w);

    const board = solvableBoard(h, w, l);
    const t0 = performance.now();
    const result = solveBoard(board, g);
    const ms = performance.now() - t0;

    timings.push({ d, H, W, ms, count });
    if (result.clickCount === null) throw new Error('基准盘面应当有解');
  }

  // ---- 报告 ----
  const lines: string[] = [];
  lines.push('');
  lines.push('════════════════════════════════════════════════════════════');
  lines.push(' 翻转灯谜求解器 · 性能基准（行宽上限 64，每行 1~2 个 32 位字）');
  lines.push('════════════════════════════════════════════════════════════');
  lines.push(` 尺寸枚举（1..${MAX_SIDE} 共 ${pairs} 种）几何预处理总耗时：${geometryMs.toFixed(0)} ms`);
  lines.push(` 单尺寸几何预处理均值：${(geometryMs / pairs).toFixed(2)} ms`);
  lines.push('');

  lines.push(' 各 d 值的实测求解耗时（每个 d 取面积最大的代表尺寸）');
  lines.push(' ┌────────┬─────┬────────────────┬──────────┬──────────────┐');
  lines.push(' │ 尺寸   │  d  │   解的总数     │   耗时   │ 每毫秒迭代数 │');
  lines.push(' ├────────┼─────┼────────────────┼──────────┼──────────────┤');
  for (const t of timings) {
    const size = `${t.H}×${t.W}`.padEnd(6);
    const d = String(t.d).padEnd(3);
    const cnt = t.count.toLocaleString('en-US').padEnd(14);
    const ms = `${t.ms.toFixed(0)} ms`.padEnd(8);
    const rate = (t.count / Math.max(t.ms, 0.001)).toFixed(0).padEnd(12);
    lines.push(` │ ${size} │ ${d} │ ${cnt} │ ${ms} │ ${rate} │`);
  }
  lines.push(' └────────┴─────┴────────────────┴──────────┴──────────────┘');
  lines.push('');

  const big = timings.filter((t) => t.d >= 16);
  const ref = big.length > 0 ? big.reduce((a, b) => (a.count > b.count ? a : b)) : timings[timings.length - 1];
  const itersPerMs = ref.count / Math.max(ref.ms, 0.001);

  lines.push(` 参考吞吐：${(itersPerMs * 1000).toExponential(2)} 次/秒（基于 d=${ref.d} 的实测）`);
  lines.push('');
  lines.push(' 按此吞吐外推的各 d 预计耗时：');
  for (const d of [18, 20, 22, 24, 26, 28, 30, 32, 40]) {
    const ms = Math.pow(2, d) / itersPerMs;
    const human = ms < 1000 ? `${ms.toFixed(0)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} 分钟`;
    lines.push(`   d = ${String(d).padStart(2)}  →  ${human}`);
  }
  lines.push('');

  // ---- 尺寸清单 ----
  const INTERACTIVE_MS = 1500;
  const maxD = Math.floor(Math.log2(INTERACTIVE_MS * itersPerMs));

  const feasible: Array<[number, number, number]> = [];
  const borderline: Array<[number, number, number]> = [];
  const blocked: Array<[number, number, number]> = [];

  for (const [d, sizes] of byD.entries()) {
    for (const [H, W] of sizes) {
      if (d === 0) continue;
      if (d <= maxD - 2) feasible.push([H, W, d]);
      else if (d <= maxD) borderline.push([H, W, d]);
      else blocked.push([H, W, d]);
    }
  }

  const area = (t: [number, number, number]): number => t[0] * t[1];
  const biggest = (list: Array<[number, number, number]>): [number, number, number] | null =>
    list.length === 0 ? null : list.reduce((a, b) => (area(b) > area(a) ? b : a));
  const hardest = blocked.length > 0 ? blocked.reduce((a, b) => (b[2] > a[2] ? b : a)) : null;

  lines.push(` 以 ${INTERACTIVE_MS} ms 为交互上限（对应 d ≤ ${maxD}）：`);
  lines.push(`   可即时求解的尺寸：${feasible.length} 种`);
  lines.push(`   接近上限的尺寸：  ${borderline.length} 种`);
  lines.push(`   超出预算的尺寸：  ${blocked.length} 种`);

  const fb = biggest(feasible);
  const bb = biggest(borderline);
  if (fb !== null) lines.push(`   可即时求解的最大棋盘：${fb[0]}×${fb[1]}（d=${fb[2]}）`);
  if (bb !== null) lines.push(`   接近上限的最大棋盘：  ${bb[0]}×${bb[1]}（d=${bb[2]}）`);
  if (hardest !== null) {
    lines.push(`   最难的尺寸：${hardest[0]}×${hardest[1]}（d=${hardest[2]}，约 ${Math.pow(2, hardest[2]).toExponential(1)} 种解）`);
  }

  const heavy = [...byD.entries()]
    .filter(([d]) => d >= 22)
    .flatMap(([d, sizes]) => sizes.map(([H, W]) => `${H}×${W}(d=${d})`))
    .sort();

  lines.push('');
  lines.push(` d = 0 的尺寸（唯一解，无需枚举）共 ${byD.get(0)?.length ?? 0} 种，未计入上表。`);
  lines.push(` d ≥ 22 的尺寸共 ${heavy.length} 种：`);
  lines.push(`   ${heavy.join('  ')}`);
  lines.push('════════════════════════════════════════════════════════════');
  lines.push('');

  console.log(lines.join('\n'));
});
