/**
 * 求解 Worker。
 *
 * 存在理由只有一个：指数搜索会占用 CPU 数百毫秒到数秒（甚至到时限），
 * 放在主线程会让棋盘无法点击。这里不做任何 DOM 操作。
 *
 * 几何（消元结果、零空间基）只与尺寸有关，缓存在本 Worker 实例内，
 * 同一尺寸的连续求解不会重复预处理。
 */

import { layout, popcountBoard } from './kernel/bitset.ts';
import { applyClicks, clicksToBoardSpace, invert, isGoal, toCanonical } from './kernel/rules.ts';
import { prepare, solveBoard, type Geometry } from './kernel/solve.ts';

export type Goal = 'off' | 'on';

export interface SolveRequest {
  readonly id: number;
  readonly H: number;
  readonly W: number;
  readonly lights: Uint32Array;
  /** 解到全灭还是全亮。 */
  readonly goal: Goal;
  /** 毫秒；0 表示不限时。 */
  readonly timeLimitMs: number;
}

export interface SerializedResult {
  readonly status: string;
  readonly solvable: boolean;
  readonly optimalProven: boolean;
  readonly clicks: Uint32Array | null;
  readonly clickCount: number | null;
  readonly solutionCount: number;
  readonly rank: number;
  readonly nullity: number;
  readonly method: string;
  readonly checked: number;
  readonly total: number;
  readonly timedOut: boolean;
  readonly elapsedMs: number;
}

export type SolveResponse =
  | { readonly id: number; readonly ok: true; readonly result: SerializedResult }
  | { readonly id: number; readonly ok: false; readonly error: string };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SolveRequest>) => void) | null;
};

const cache = new Map<string, Geometry>();

function geometryFor(h: number, w: number): Geometry {
  const key = `${h}x${w}`;
  let g = cache.get(key);
  if (g === undefined) {
    g = prepare(h, w);
    cache.set(key, g);
  }
  return g;
}

scope.onmessage = (event) => {
  const request = event.data;
  const started = performance.now();

  try {
    const boardLayout = layout(request.H, request.W);
    const toOn = request.goal === 'on';

    // 「解到全亮」等价于「把盘面逐位取反后解到全灭」，点击方案完全相同。
    const target = toOn ? invert(request.lights, boardLayout) : request.lights;

    const canonical = toCanonical(target, request.H, request.W);
    const g = geometryFor(canonical.l.h, canonical.l.w);
    const solved = solveBoard(canonical.rows, g, { timeLimitMs: request.timeLimitMs });

    let clicks: Uint32Array | null = null;
    if (solved.clicks !== null) {
      const inBoardSpace = clicksToBoardSpace(solved.clicks, canonical);

      // 规范要求：返回前用原始规则重放一次，确认达标且点击数一致
      const after = applyClicks(request.lights, inBoardSpace, boardLayout);
      if (!isGoal(after, boardLayout, toOn)) {
        throw new Error('内核错误：返回的方案未能使棋盘达标');
      }
      const counted = popcountBoard(inBoardSpace, boardLayout);
      if (counted !== solved.clickCount) {
        throw new Error('内核错误：点击数统计不一致');
      }

      clicks = inBoardSpace;
    }

    const result: SerializedResult = {
      status: solved.status,
      solvable: solved.solvable,
      optimalProven: solved.optimalProven,
      clicks,
      clickCount: solved.clickCount,
      solutionCount: solved.solutionCount,
      rank: solved.rank,
      nullity: solved.nullity,
      method: solved.method,
      checked: solved.checked,
      total: solved.total,
      timedOut: solved.timedOut,
      elapsedMs: performance.now() - started,
    };

    const transfer: Transferable[] = [];
    if (clicks !== null) transfer.push(clicks.buffer);

    scope.postMessage({ id: request.id, ok: true, result }, transfer);
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
