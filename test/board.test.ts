/**
 * 画布棋盘的交互契约。
 *
 * 真正的绘制发生在浏览器里，Node 测不了像素；但「哪个坐标对应哪一格」
 * 「拖动超过多少像素就不再算点击」「缩放时锚点是否漂移」这三件事
 * 全是纯逻辑，用一个极简的假 DOM 就能盯住 —— 而它们恰恰是最容易写错、
 * 又只有在用户点下去时才暴露的部分。
 */

import test from 'node:test';
import assert from 'node:assert';
import { DEFAULT_CELL, defaultView } from '../src/ui/view.ts';

interface PathStep {
  op: string;
  args: number[];
}

interface PaintRecord {
  op: 'fill' | 'stroke';
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  path: PathStep[];
}

interface Stats {
  fill: number;
  stroke: number;
  fillRect: number;
  clear: number;
  arc: number;
  /** 每次 fill/stroke 时的路径快照，用来验形状 */
  paths: PathStep[][];
  /** 每次 fill/stroke 时的完整画笔状态，用来验样式与绘制顺序 */
  paints: PaintRecord[];
}

function makeContext(): { ctx: Record<string, unknown>; stats: Stats } {
  const stats: Stats = { fill: 0, stroke: 0, fillRect: 0, clear: 0, arc: 0, paths: [], paints: [] };
  let path: PathStep[] = [];
  const record = (op: string) => (...args: number[]) => {
    path.push({ op, args });
  };
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    setTransform() {},
    clearRect() { stats.clear++; },
    beginPath() { path = []; },
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    rect: record('rect'),
    arcTo: record('arcTo'),
    arc(...args: number[]) { path.push({ op: 'arc', args }); stats.arc++; },
    closePath: record('closePath'),
    fill() {
      stats.fill++;
      stats.paths.push(path.slice());
      stats.paints.push({
        op: 'fill',
        fillStyle: ctx.fillStyle as string,
        strokeStyle: ctx.strokeStyle as string,
        lineWidth: ctx.lineWidth as number,
        globalAlpha: ctx.globalAlpha as number,
        path: path.slice(),
      });
    },
    stroke() {
      stats.stroke++;
      stats.paths.push(path.slice());
      stats.paints.push({
        op: 'stroke',
        fillStyle: ctx.fillStyle as string,
        strokeStyle: ctx.strokeStyle as string,
        lineWidth: ctx.lineWidth as number,
        globalAlpha: ctx.globalAlpha as number,
        path: path.slice(),
      });
    },
    fillRect() { stats.fillRect++; },
  };
  return { ctx, stats };
}

type Handler = (event: unknown) => void;

function makeCanvas(width: number, height: number) {
  const { ctx, stats } = makeContext();
  const handlers = new Map<string, Handler>();
  const canvas = {
    className: '',
    width: 0,
    height: 0,
    style: {},
    stats,
    setAttribute() {},
    getContext() { return ctx; },
    addEventListener(type: string, handler: Handler) { handlers.set(type, handler); },
    setPointerCapture() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width, height, right: width, bottom: height }; },
    fire(type: string, event: unknown) {
      const handler = handlers.get(type);
      if (handler === undefined) throw new Error(`没有注册 ${type} 事件`);
      const withDefaults = { preventDefault() {}, ...(event as Record<string, unknown>) };
      handler(withDefaults);
    },
    has(type: string) { return handlers.has(type); },
  };
  return canvas;
}

const WIDTH = 800;
const HEIGHT = 600;
const rafQueue: Array<() => void> = [];

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = { devicePixelRatio: 2 };
globals.requestAnimationFrame = (fn: () => void) => {
  rafQueue.push(fn);
  return rafQueue.length;
};
globals.cancelAnimationFrame = () => {
  // 队列会按序被 flush 掉，句柄不再有意义；被「取消」的那一帧最多多画一次，
  // 而且它读到的是已经落定的视图，会立刻判定为收敛，不影响任何断言
};
globals.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const canvases: ReturnType<typeof makeCanvas>[] = [];
globals.document = {
  createElement() {
    const canvas = makeCanvas(WIDTH, HEIGHT);
    canvases.push(canvas);
    return canvas;
  },
};

const wrapClasses = new Set<string>();
const classList = {
  add(name: string) { wrapClasses.add(name); },
  remove(name: string) { wrapClasses.delete(name); },
  toggle(name: string, on: boolean) {
    if (on) wrapClasses.add(name);
    else wrapClasses.delete(name);
  },
};
const wrapHandlers = new Map<string, Handler>();
const wrap = {
  classList,
  focus() {},
  addEventListener(type: string, handler: Handler) { wrapHandlers.set(type, handler); },
  fire(type: string, event: unknown) {
    const handler = wrapHandlers.get(type);
    if (handler === undefined) throw new Error(`容器没有注册 ${type} 事件`);
    const withDefaults = { preventDefault() {}, ...(event as Record<string, unknown>) };
    handler(withDefaults);
  },
  getBoundingClientRect() { return { left: 0, top: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT }; },
  append(...nodes: unknown[]) {
    void nodes;
  },
};

function flush(): void {
  while (rafQueue.length > 0) rafQueue.shift()!();
}

const { createBoard } = await import('../src/ui/board.ts');

function setup(H: number, W: number, lit: (r: number, c: number) => boolean = () => false) {
  canvases.length = 0;
  const toggles: Array<{ r: number; c: number }> = [];
  const board = createBoard(wrap as unknown as HTMLElement, (r, c) => toggles.push({ r, c }));
  board.reset(H, W, (r, c) => ({ on: lit(r, c), mark: 'none' as const }));
  flush();
  return { board, toggles, base: canvases[0], overlay: canvases[1] };
}

/** 视图里第 (r,c) 格的中心点。每次重新按默认视图推算，避免依赖内部状态。 */
function centerOf(H: number, W: number, r: number, c: number): { x: number; y: number } {
  const availW = WIDTH - 56;
  const availH = HEIGHT - 56;
  const scale = Math.max(1, Math.min(DEFAULT_CELL, availW / W, availH / H));
  const offsetX = (WIDTH - W * scale) / 2;
  const offsetY = (HEIGHT - H * scale) / 2;
  return { x: offsetX + (c + 0.5) * scale, y: offsetY + (r + 0.5) * scale };
}

function click(base: ReturnType<typeof makeCanvas>, x: number, y: number): void {
  base.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y });
  base.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y });
}

/** 从路径步骤里取矩形外沿（arcTo 的拐点与 moveTo 就是矩形边）。 */
function pathBounds(path: PathStep[]): { left: number; top: number } {
  let left = Infinity;
  let top = Infinity;
  for (const step of path) {
    if (step.op !== 'moveTo' && step.op !== 'arcTo') continue;
    left = Math.min(left, step.args[0]);
    top = Math.min(top, step.args[1]);
  }
  return { left, top };
}

test('点哪格就是哪格：整盘逐格点击都不错位', () => {
  const H = 4;
  const W = 6;
  const { base, toggles } = setup(H, W);

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const point = centerOf(H, W, r, c);
      click(base, point.x, point.y);
    }
  }

  assert.equal(toggles.length, H * W);
  let i = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) assert.deepEqual(toggles[i++], { r, c });
  }
});

test('点位落在棋盘外不触发点击', () => {
  const { base, toggles } = setup(3, 3);
  click(base, 2, 2);
  click(base, WIDTH - 2, HEIGHT - 2);
  assert.equal(toggles.length, 0);
});

test('右键只负责平移；左键始终只负责下棋', () => {
  const H = 12;
  const W = 12;
  const { base, toggles } = setup(H, W);

  base.fire('wheel', { deltaY: -600, deltaMode: 0, clientX: 400, clientY: 300, preventDefault() {} });
  flush();

  click(base, 400, 300);
  assert.equal(toggles.length, 1);
  const anchor = toggles[0];

  // 在格子上用右键拖 120px：只移动视图，不翻灯
  base.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 200, clientY: 200 });
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 320, clientY: 200 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 320, clientY: 200 });
  assert.equal(toggles.length, 1, '右键拖动不应该翻灯');

  click(base, 400 + 120, 300);
  assert.deepEqual(toggles[1], anchor, '平移后命中判定必须跟着走');
});

test('滚轮缩放以光标为锚点，光标下那一格不变', () => {
  const H = 5;
  const W = 5;
  const { base, toggles } = setup(H, W);

  const point = centerOf(H, W, 2, 1);

  for (const deltaY of [-120, -120, 240]) {
    base.fire('wheel', {
      deltaY,
      deltaMode: 0,
      clientX: point.x,
      clientY: point.y,
      preventDefault() {},
    });
  }
  flush(); // 缩放是带缓动的动画，得等它落定再点

  click(base, point.x, point.y);
  assert.deepEqual(toggles[0], { r: 2, c: 1 }, '缩放后锚点下的格子必须还是原来那格');
});

test('左键按下后移出格子会取消，不会误点别的格子', () => {
  const H = 3;
  const W = 3;
  const { base, toggles } = setup(H, W);
  const point = centerOf(H, W, 1, 1);

  base.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: point.x, clientY: point.y });
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: point.x + 140, clientY: point.y + 60 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: point.x + 140, clientY: point.y + 60 });

  assert.equal(toggles.length, 0, '移出格子后松手应当取消这次点击');
});

test('放大之后怎么拖，棋盘都不会被拖出视野', () => {
  const H = 12;
  const W = 12;
  const { base, toggles } = setup(H, W);

  base.fire('wheel', { deltaY: -600, deltaMode: 0, clientX: 400, clientY: 300, preventDefault() {} });
  flush();

  for (let i = 0; i < 6; i++) {
    base.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 100, clientY: 100 });
    base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 790, clientY: 590 });
    base.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 790, clientY: 590 });
  }

  // 棋盘盖满画布，所以四个角和中心点下去都必须落在某一格上
  for (const [x, y] of [[5, 5], [795, 5], [5, 595], [795, 595], [400, 300]]) click(base, x, y);
  assert.equal(toggles.length, 5, '拖到边界后棋盘仍然盖满画布');
});

test('复位：缩放平移归零，回到初始适配视图', () => {
  const H = 10;
  const W = 10;
  const { board, base, toggles } = setup(H, W);
  const point = centerOf(H, W, 4, 4);

  base.fire('wheel', { deltaY: -600, deltaMode: 0, clientX: 100, clientY: 100, preventDefault() {} });
  flush();
  base.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 200, clientY: 200 });
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 330, clientY: 260 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2, clientX: 330, clientY: 260 });
  flush();

  board.resetView();
  flush();

  click(base, point.x, point.y);
  assert.deepEqual(toggles[0], { r: 4, c: 4 }, '复位后坐标系必须回到初始适配视图');
});

test('格子画的是圆角矩形，不是三角形', () => {
  const { base } = setup(3, 3);

  // 面板与格子都走 roundRect，取四个 arcTo 的那些路径（= 圆角形状）
  const roundPaths = base.stats.paths.filter((p) => p.filter((s) => s.op === 'arcTo').length === 4);
  assert.ok(roundPaths.length >= 9, `圆角路径太少：${roundPaths.length}`);

  for (const path of roundPaths) {
    const arcs = path.filter((s) => s.op === 'arcTo');

    for (const arc of arcs) {
      const [x1, y1, x2, y2] = arc.args;
      // 两个控制点重合时 arcTo 无解，浏览器会退化出一条直线，
      // 整条路径就从圆角矩形变成三角形 —— 这正是曾经出现过的 bug
      assert.ok(!(x1 === x2 && y1 === y2), `arcTo 控制点重合 (${x1},${y1})，会退化成三角形`);
    }

    // 四个拐点必须正好是矩形的四个角：只有两种 x、两种 y，且四个组合互不重复
    assert.equal(new Set(arcs.map((a) => a.args[0])).size, 2, '四个拐点应落在两条竖线上');
    assert.equal(new Set(arcs.map((a) => a.args[1])).size, 2, '四个拐点应落在两条横线上');
    assert.equal(new Set(arcs.map((a) => `${a.args[0]},${a.args[1]}`)).size, 4, '四个拐点不能重复');
  }
});

test('绘制确实发生了，且同一帧内的多次更新只重画一次', () => {
  const { board, base } = setup(8, 8, (r, c) => (r + c) % 2 === 0);

  assert.ok(base.stats.clear > 0, '应当清过画布');
  assert.ok(base.stats.fill >= 8 * 8, `填充次数过少：${base.stats.fill}`);
  assert.equal(base.stats.fillRect + base.stats.fill > 0, true);

  const before = base.stats.clear;
  // 同一帧内反复写入同一状态，不能每次写入都重画一遍
  for (let i = 0; i < 6; i++) board.paint(3, 3, { on: true, mark: 'none' });
  board.repaint((r, c) => ({ on: (r + c) % 2 === 0, mark: 'none' }));

  assert.equal(base.stats.clear, before, '还没到下一帧就不该绘制');
  flush();
  assert.equal(base.stats.clear, before + 1, '同一帧内的多次更新必须合并成一次绘制');
});

test('标记出现时有弹入动画，且几帧后必须停下', () => {
  const { board, base } = setup(4, 4);
  flush();

  const before = base.stats.clear;
  board.paint(1, 1, { on: false, mark: 'hit' });
  flush();

  const frames = base.stats.clear - before;
  assert.ok(frames > 1, `标记应当有入场动画，实际只画了 ${frames} 帧`);
  assert.ok(frames <= 12, `动画帧数过多：${frames}`);
});

test('游戏模式悬停预览十字，设置模式只预览当前格', () => {
  const { board, base, overlay } = setup(4, 4);
  const point = centerOf(4, 4, 2, 2);

  board.setInteraction('game', true);
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: point.x, clientY: point.y });
  flush();
  assert.ok(overlay.stats.stroke > 0 && overlay.stats.stroke % 5 === 0, '每帧都应画出完整的五格十字');

  overlay.stats.stroke = 0;
  board.setInteraction('setup', true);
  flush();
  assert.ok(overlay.stats.stroke > 0 && overlay.stats.stroke <= 10, '设置模式的淡入动画每帧只画当前格');
});

test('悬浮预览必须实时跟随鼠标：淡入落定后换格要立即画到新位置', () => {
  const { board, base, overlay } = setup(4, 4);
  board.setInteraction('game', true);
  const first = centerOf(4, 4, 0, 0);
  const second = centerOf(4, 4, 2, 2); // 内部格：十字完整，五格十笔

  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: first.x, clientY: first.y });
  flush(); // 淡入彻底落定：hoverAlpha === 1，一切动画停了

  overlay.stats.paths.length = 0;
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: second.x, clientY: second.y });
  flush();

  // 曾经的 bug：换格后 hoverAlpha === hoverTarget，pump 里没有任何分支置脏，
  // 十字就冻在淡入结束时的位置，只在别的动画碰巧跑时跳一下
  assert.ok(overlay.stats.paths.length >= 10, `换格后必须立即重画整个十字，实际只画了 ${overlay.stats.paths.length} 笔`);

  const view = defaultView(WIDTH, HEIGHT, 4, 4);
  const last = pathBounds(overlay.stats.paths[overlay.stats.paths.length - 1]);
  assert.ok(
    Math.abs(last.left - (view.offsetX + 2 * view.scale + 0.5)) < 0.01,
    `中心格应画在 (2,2) 的左边缘上，实际 left=${last.left}`,
  );
  assert.ok(
    Math.abs(last.top - (view.offsetY + 2 * view.scale + 0.5)) < 0.01,
    `中心格应画在 (2,2) 的上边缘上，实际 top=${last.top}`,
  );
});

test('十字预览有层次：中心格描边更粗、最后落笔，四邻明显更弱', () => {
  const { board, base, overlay } = setup(4, 4);
  board.setInteraction('game', true);
  const point = centerOf(4, 4, 1, 1);
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: point.x, clientY: point.y });
  flush();

  const view = defaultView(WIDTH, HEIGHT, 4, 4);
  const centerLeft = view.offsetX + 1 * view.scale + 0.5;
  const centerTop = view.offsetY + 1 * view.scale + 0.5;
  const isCenter = (paint: PaintRecord): boolean => {
    const bounds = pathBounds(paint.path);
    return Math.abs(bounds.left - centerLeft) < 0.01 && Math.abs(bounds.top - centerTop) < 0.01;
  };

  const strokes = overlay.stats.paints.filter((paint) => paint.op === 'stroke');
  const centerStrokes = strokes.filter(isCenter);
  const neighborStrokes = strokes.filter((paint) => !isCenter(paint));

  assert.ok(centerStrokes.length > 0, '中心格必须有描边');
  assert.equal(Math.max(...centerStrokes.map((s) => s.lineWidth)), 2, '中心格描边应为 2px');
  assert.equal(Math.max(...neighborStrokes.map((s) => s.lineWidth)), 1, '四邻描边必须比中心细');
  assert.ok(neighborStrokes.length >= centerStrokes.length * 4, '四邻每帧都该有描边');
  assert.ok(isCenter(strokes[strokes.length - 1]), '中心格必须最后落笔，视觉层级压在四邻之上');
});

test('方向键移动光标，回车下棋', () => {
  const { toggles } = setup(5, 5);
  const key = (key: string) => ({ key, preventDefault() {} });

  wrap.fire('keydown', key('ArrowLeft'));
  wrap.fire('keydown', key('ArrowUp'));
  wrap.fire('keydown', key('Enter'));

  assert.deepEqual(toggles, [{ r: 1, c: 1 }], '键盘应从中心移动到 (1,1) 并翻转');
});

test('按住空格后用左键拖动只平移，不翻灯', () => {
  const { base, toggles } = setup(12, 12);
  base.fire('wheel', { deltaY: -600, deltaMode: 0, clientX: 400, clientY: 300, preventDefault() {} });
  flush();

  wrap.fire('keydown', { key: ' ', preventDefault() {} });
  base.fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
  base.fire('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 390, clientY: 340 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 390, clientY: 340 });
  wrap.fire('keyup', { key: ' ' });

  assert.equal(toggles.length, 0, '空格拖动不能触发下棋');
});

test('禁用交互时点击不生效，恢复后正常', () => {
  const { board, base, toggles } = setup(3, 3);
  const point = centerOf(3, 3, 1, 1);

  board.setInteraction('game', false);
  click(base, point.x, point.y);
  assert.equal(toggles.length, 0);

  board.setInteraction('game', true);
  click(base, point.x, point.y);
  assert.deepEqual(toggles, [{ r: 1, c: 1 }]);
});

test('触屏单指：按下即预览，松手同格落子', () => {
  const { board, base, toggles } = setup(4, 4);
  board.setInteraction('game', true);
  const point = centerOf(4, 4, 2, 2);

  base.fire('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x, clientY: point.y });
  base.fire('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x, clientY: point.y });

  assert.deepEqual(toggles, [{ r: 2, c: 2 }], '触屏松手同格应当落子');
});

test('触屏单指：滑出格子松手即取消，不落子', () => {
  const { board, base, toggles } = setup(4, 4);
  board.setInteraction('game', true);
  const point = centerOf(4, 4, 1, 1);

  base.fire('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x, clientY: point.y });
  base.fire('pointermove', { pointerId: 1, pointerType: 'touch', clientX: point.x + 160, clientY: point.y + 80 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x + 160, clientY: point.y + 80 });

  assert.equal(toggles.length, 0, '触屏滑动超过阈值应转为平移，不落子');
});

test('触屏单指：位移在阈值内仍算下棋', () => {
  const { board, base, toggles } = setup(4, 4);
  board.setInteraction('game', true);
  const point = centerOf(4, 4, 2, 2);

  // 位移 8px < 阈值 20px：仍是「点一下下棋」
  base.fire('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x, clientY: point.y });
  base.fire('pointermove', { pointerId: 1, pointerType: 'touch', clientX: point.x + 8, clientY: point.y + 4 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x + 8, clientY: point.y + 4 });

  assert.deepEqual(toggles, [{ r: 2, c: 2 }], '位移小于阈值时松手应当落子');
});

test('触屏单指：位移超过阈值转为平移，不落子', () => {
  const { board, base, toggles } = setup(4, 4);
  board.setInteraction('game', true);
  const point = centerOf(4, 4, 2, 2);

  // 位移 30px > 阈值 20px：转为平移
  base.fire('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x, clientY: point.y });
  base.fire('pointermove', { pointerId: 1, pointerType: 'touch', clientX: point.x + 30, clientY: point.y + 0 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: point.x + 30, clientY: point.y + 0 });

  assert.equal(toggles.length, 0, '位移超过阈值时应平移而非落子');
});

test('触屏双指：捏合缩放，不会误落子', () => {
  const { board, base, toggles } = setup(4, 4);
  board.setInteraction('game', true);

  // 第一指落下（落在格子上，本可能触发落子）
  const c1 = centerOf(4, 4, 1, 1);
  base.fire('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: c1.x, clientY: c1.y });
  // 第二指落下：进入捏合，取消正在进行的落子
  base.fire('pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: c1.x + 40, clientY: c1.y });
  // 两指张开：缩放
  base.fire('pointermove', { pointerId: 2, pointerType: 'touch', clientX: c1.x + 120, clientY: c1.y });
  // 两指都抬起
  base.fire('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: c1.x, clientY: c1.y });
  base.fire('pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: c1.x + 120, clientY: c1.y });

  assert.equal(toggles.length, 0, '双指捏合绝不能落子');
});

test('触屏双指：抬起一根后退化为单指平移，继续跟手', () => {
  const { board, base, toggles } = setup(12, 12);
  board.setInteraction('game', true);
  base.fire('wheel', { deltaY: -600, deltaMode: 0, clientX: 400, clientY: 300, preventDefault() {} });
  flush();

  const startX = 400;
  const startY = 300;
  base.fire('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: startX, clientY: startY });
  base.fire('pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: startX + 50, clientY: startY });
  base.fire('pointermove', { pointerId: 2, pointerType: 'touch', clientX: startX + 90, clientY: startY });
  // 抬起第二指：捏合退化为平移，第一指继续拖动
  base.fire('pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: startX + 90, clientY: startY });
  base.fire('pointermove', { pointerId: 1, pointerType: 'touch', clientX: startX + 60, clientY: startY + 40 });
  base.fire('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: startX + 60, clientY: startY + 40 });

  assert.equal(toggles.length, 0, '捏合退化平移不能落子');
});

test('翻灯有短暂过渡且会收敛，完成动画也会停下', () => {
  const { board, base, overlay } = setup(5, 5);

  let before = base.stats.clear;
  board.paint(2, 2, { on: true, mark: 'none' });
  flush();
  const transitionFrames = base.stats.clear - before;
  assert.ok(transitionFrames > 1 && transitionFrames <= 8, `翻灯过渡帧数异常：${transitionFrames}`);

  before = overlay.stats.clear;
  board.celebrate(2, 2);
  flush();
  const celebrateFrames = overlay.stats.clear - before;
  assert.ok(celebrateFrames > 1 && celebrateFrames <= 42, `完成动画未正常收敛：${celebrateFrames}`);
});
