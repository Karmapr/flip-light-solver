/**
 * 会话状态机。
 *
 * 三样互相独立的东西：
 *   盘面   —— 唯一的状态数据
 *   模式   —— 只决定「点击怎么解释」
 *   目标   —— 只决定「什么算解完」
 *
 * 以及一个只在解题引导阶段存在的东西：剩余方案。
 *
 * 引导阶段的核心规则只有一条，但它同时管住了「点对」和「点错」：
 *
 *     每点一格 x：盘面 ^= cross(x)，方案 ^= {x}
 *
 * 因为翻转是线性的，方案更新后仍然是当前盘面的合法解 —— 按提示点下去一定能到目标态。
 * 点到不该点的格子时，这一位会重新出现在方案里，于是它被标记成「需要点击」，
 * 再点一次就撤回了这步。所以「点错」在代码里不是一个分支，只是一个颜色。
 *
 * 代价也是精确的：总点击数 = 原最优 + 2 × 点错的格子数。
 */

import { layout, popcountBoard, type Layout } from '../kernel/bitset.ts';
import { applyClicks, invert, isGoal } from '../kernel/rules.ts';
import type { Goal, SerializedResult, SolveRequest } from '../solver.worker.ts';

export type Mode = 'setup' | 'game';
export type Phase = 'ready' | 'solving' | 'guiding' | 'done';
export type { Goal };

export interface CellRef {
  readonly r: number;
  readonly c: number;
}

export interface ClickOutcome {
  /** 需要重绘的格子。 */
  readonly cells: readonly CellRef[];
  /** 为 true 时整盘重绘（方案被清空、或尺寸变化）。 */
  readonly full: boolean;
}

export interface PanelModel {
  readonly kind: 'idle' | 'solving' | 'unsolvable' | 'guiding' | 'done';
  readonly result: SerializedResult | null;
  /** 本次求解后已经点了几次。 */
  readonly used: number;
  /** 方案里还剩几次点击。 */
  readonly remaining: number;
  /** 本次求解的最优点击数。 */
  readonly optimum: number | null;
  /** 点了但当时不该点的格子数（每个让总次数多 2）。 */
  readonly wrong: number;
}

const MIN_SIDE = 1;
const MAX_SIDE = 64;
const DEFAULT_BUDGET_SECONDS = 10;

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return MIN_SIDE;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.trunc(value)));
}

function bitAt(a: Uint32Array, l: Layout, r: number, c: number): number {
  return (a[r * l.words + (c >>> 5)] >>> (c & 31)) & 1;
}

function toggleBit(a: Uint32Array, l: Layout, r: number, c: number): void {
  a[r * l.words + (c >>> 5)] ^= 1 << (c & 31);
}

function setBit(a: Uint32Array, l: Layout, r: number, c: number): void {
  a[r * l.words + (c >>> 5)] |= 1 << (c & 31);
}

function countBoth(a: Uint32Array, b: Uint32Array, size: number): number {
  let total = 0;
  for (let i = 0; i < size; i++) {
    let v = a[i] & b[i];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0f0f0f0f;
    total += Math.imul(v, 0x01010101) >>> 24;
  }
  return total;
}

export class Session {
  H = 5;
  W = 5;
  lights = new Uint32Array(5);
  mode: Mode = 'setup';
  goal: Goal = 'off';
  phase: Phase = 'ready';
  budgetSeconds = DEFAULT_BUDGET_SECONDS;
  /** 每次发起求解递增；结果回来时若已变化就丢弃。 */
  epoch = 0;

  private plan: Uint32Array | null = null;
  private clicked: Uint32Array | null = null;
  private clicksMade = 0;
  private optimum: number | null = null;
  private lastResult: SerializedResult | null = null;
  /** 发起求解前的模式：无解时要恢复它，而不是停在 game。 */
  private modeBeforeSolve: Mode = 'setup';

  // 尺寸不变时复用同一个 Layout：重建网格时它会被问上万次
  private cached: Layout | null = null;
  private cachedH = 0;
  private cachedW = 0;

  get l(): Layout {
    if (this.cached === null || this.cachedH !== this.H || this.cachedW !== this.W) {
      this.cached = layout(this.H, this.W);
      this.cachedH = this.H;
      this.cachedW = this.W;
    }
    return this.cached;
  }

  // ---------- 盘面 ----------

  resize(H: number, W: number): void {
    this.H = clampSide(H);
    this.W = clampSide(W);
    this.lights = new Uint32Array(this.l.size);
    this.clearSolution();
  }

  fill(on: boolean): void {
    const l = this.l;
    this.lights = on ? invert(new Uint32Array(l.size), l) : new Uint32Array(l.size);
    this.clearSolution();
  }

  /** 随机可解：先随机生成一张点击图案，再把它施加到目标态上。 */
  randomSolvable(): void {
    const l = this.l;
    const goalBoard = this.goal === 'on' ? invert(new Uint32Array(l.size), l) : new Uint32Array(l.size);

    for (let attempt = 0; attempt < 64; attempt++) {
      const clicks = new Uint32Array(l.size);
      for (let r = 0; r < this.H; r++) {
        for (let c = 0; c < this.W; c++) {
          if (Math.random() < 0.4) setBit(clicks, l, r, c);
        }
      }
      const board = applyClicks(goalBoard, clicks, l);
      if (!isGoal(board, l, this.goal === 'on')) {
        this.lights = board;
        this.clearSolution();
        return;
      }
    }
    this.fill(false);
  }

  /** 完全随机：均匀采样，可解概率只有 2^-d，大棋盘上几乎必然无解。 */
  randomAny(): void {
    const l = this.l;
    for (let attempt = 0; attempt < 16; attempt++) {
      const board = new Uint32Array(l.size);
      for (let r = 0; r < this.H; r++) {
        for (let c = 0; c < this.W; c++) {
          if (Math.random() < 0.5) setBit(board, l, r, c);
        }
      }
      if (!isGoal(board, l, this.goal === 'on')) {
        this.lights = board;
        this.clearSolution();
        return;
      }
    }
    this.fill(false);
  }

  // ---------- 模式与目标 ----------

  setMode(mode: Mode): void {
    if (this.phase === 'solving' || mode === this.mode) return;
    this.mode = mode;
    // 显式切回设置模式 = 打算改盘面，引导自然作废
    if (mode === 'setup' && (this.phase === 'guiding' || this.phase === 'done')) {
      this.clearSolution();
    }
  }

  setGoal(goal: Goal): void {
    if (this.goal === goal) return;
    this.goal = goal;
    this.clearSolution();
  }

  setBudgetSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      this.budgetSeconds = DEFAULT_BUDGET_SECONDS;
      return;
    }
    this.budgetSeconds = Math.min(600, seconds);
  }

  get budgetMs(): number {
    return Math.round(this.budgetSeconds * 1000);
  }

  // ---------- 点击 ----------

  cellState(r: number, c: number): { on: boolean; mark: 'none' | 'hit' | 'wrong' } {
    const l = this.l;
    const marked = this.plan !== null && bitAt(this.plan, l, r, c) === 1;
    if (!marked) return { on: bitAt(this.lights, l, r, c) === 1, mark: 'none' };
    const wasClicked = this.clicked !== null && bitAt(this.clicked, l, r, c) === 1;
    return { on: bitAt(this.lights, l, r, c) === 1, mark: wasClicked ? 'wrong' : 'hit' };
  }

  click(r: number, c: number): ClickOutcome {
    if (this.phase === 'solving') return { cells: [], full: false };
    const l = this.l;
    const hadPlan = this.plan !== null;

    if (this.mode === 'setup') {
      toggleBit(this.lights, l, r, c);
      this.clearSolution();
      return { cells: [{ r, c }], full: hadPlan };
    }

    // 完成后继续点，就退回到「自己玩」的状态
    if (this.phase === 'done') this.clearSolution();

    const touched: CellRef[] = [];
    const visit = (rr: number, cc: number): void => {      if (rr < 0 || rr >= this.H || cc < 0 || cc >= this.W) return;
      toggleBit(this.lights, l, rr, cc);
      touched.push({ r: rr, c: cc });
    };
    visit(r, c);
    visit(r - 1, c);
    visit(r + 1, c);
    visit(r, c - 1);
    visit(r, c + 1);

    if (this.phase === 'guiding' && this.plan !== null && this.clicked !== null) {
      toggleBit(this.plan, l, r, c);
      toggleBit(this.clicked, l, r, c);
      this.clicksMade++;
      if (isGoal(this.lights, l, this.goal === 'on')) {
        this.phase = 'done';
        this.plan = null;
        this.clicked = null;
        return { cells: touched, full: true };
      }
    } else if (isGoal(this.lights, l, this.goal === 'on')) {
      this.phase = 'done';
    }

    return { cells: touched, full: false };
  }

  // ---------- 求解 ----------

  beginSolve(): SolveRequest | null {
    if (this.phase === 'solving') return null;
    this.epoch++;
    this.phase = 'solving';
    this.modeBeforeSolve = this.mode;
    this.mode = 'game';
    this.plan = null;
    this.clicked = null;
    this.lastResult = null;
    return {
      id: this.epoch,
      H: this.H,
      W: this.W,
      lights: new Uint32Array(this.lights),
      goal: this.goal,
      timeLimitMs: this.budgetMs,
    };
  }

  acceptResult(id: number, result: SerializedResult): boolean {
    if (id !== this.epoch || this.phase !== 'solving') return false;
    this.lastResult = result;

    if (!result.solvable || result.clicks === null) {
      this.phase = 'ready';
      this.mode = this.modeBeforeSolve;
      this.clearSolution();
      this.lastResult = result;
      return true;
    }

    this.plan = new Uint32Array(result.clicks);
    this.clicked = new Uint32Array(this.l.size);
    this.clicksMade = 0;
    this.optimum = result.clickCount;
    this.phase = isGoal(this.lights, this.l, this.goal === 'on') ? 'done' : 'guiding';
    return true;
  }

  failSolve(id: number): boolean {
    if (id !== this.epoch) return false;
    this.phase = 'ready';
    return true;
  }

  clearSolution(): void {
    this.plan = null;
    this.clicked = null;
    this.clicksMade = 0;
    this.optimum = null;
    this.lastResult = null;
    if (this.phase !== 'solving') this.phase = 'ready';
  }

  /** 方案里还剩几次点击。 */
  get remaining(): number {
    return this.plan === null ? 0 : popcountBoard(this.plan, this.l);
  }

  /** 剩余方案的位图（只读用途，供测试与调试）。 */
  get planBits(): Uint32Array | null {
    return this.plan;
  }

  /** 点了但属于错位的格子数，每个让总次数多 2。 */
  get wrong(): number {
    if (this.plan === null || this.clicked === null) return 0;
    return countBoth(this.plan, this.clicked, this.l.size);
  }

  get used(): number {
    return this.clicksMade;
  }

  get optimumClicks(): number | null {
    return this.optimum;
  }

  panel(): PanelModel {
    const kind: PanelModel['kind'] =
      this.phase === 'solving'
        ? 'solving'
        : this.lastResult !== null && !this.lastResult.solvable
          ? 'unsolvable'
          : this.phase === 'guiding' || this.phase === 'done'
            ? this.phase
            : this.lastResult !== null
              ? 'guiding'
              : 'idle';

    return {
      kind,
      result: this.lastResult,
      used: this.used,
      remaining: this.remaining,
      optimum: this.optimum,
      wrong: this.wrong,
    };
  }
}
