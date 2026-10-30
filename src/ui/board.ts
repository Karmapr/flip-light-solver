import { cellAt, clampPan, defaultView, MAX_ZOOM, MIN_ZOOM, zoomAt, type View } from './view.ts';

export type Mark = 'none' | 'hit' | 'wrong';
export type InteractionMode = 'setup' | 'game';

export interface CellState {
  readonly on: boolean;
  readonly mark: Mark;
}

export interface BoardOptions {
  readonly onZoom?: (percent: number) => void;
}

export interface BoardView {
  reset(H: number, W: number, state: (r: number, c: number) => CellState): void;
  paint(r: number, c: number, state: CellState): void;
  repaint(state: (r: number, c: number) => CellState): void;
  resetView(): void;
  zoomBy(factor: number): void;
  setInteraction(mode: InteractionMode, enabled: boolean): void;
  celebrate(r: number, c: number): void;
}

const ZOOM_EASE = 0.34;
const ZOOM_FRAMES = 30;
const HOVER_EASE = 0.38;
const CELL_FRAMES = 7;
const MARK_FRAMES = 8;
const RIPPLE_FRAMES = 14;
const CELEBRATE_FRAMES = 42;
const SETTLE = 0.94;

/** 触屏单指：位移超过这个像素数就算「滑动平移」，否则算「点一下下棋」。 */
const TOUCH_PAN_THRESHOLD = 20;

const COLORS = {
  off: '#e5e3dc',
  on: '#e8a33d',
  panel: '#ffffff',
  line: '#d7d4cc',
  hit: '#1d1c1a',
  hitOn: '#2b1a05',
  wrong: '#a8332e',
  halo: 'rgba(20, 10, 8, 0.42)',
  hoverCenterFill: 'rgba(29, 28, 26, 0.15)',
  hoverCenterLine: 'rgba(29, 28, 26, 0.78)',
  hoverNeighborFill: 'rgba(29, 28, 26, 0.05)',
  hoverNeighborLine: 'rgba(29, 28, 26, 0.34)',
  press: 'rgba(29, 28, 26, 0.16)',
  ripple: 'rgba(29, 28, 26, 0.42)',
  done: '#2f7a54',
} as const;

const OFF_RGB = [229, 227, 220] as const;
const ON_RGB = [232, 163, 61] as const;

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  if (radius === 0) {
    c.rect(x, y, w, h);
    return;
  }
  c.moveTo(x + radius, y);
  c.arcTo(x + w, y, x + w, y + h, radius);
  c.arcTo(x + w, y + h, x, y + h, radius);
  c.arcTo(x, y + h, x, y, radius);
  c.arcTo(x, y, x + w, y, radius);
  c.closePath();
}

function sameCell(a: { r: number; c: number } | null, b: { r: number; c: number } | null): boolean {
  return a === b || (a !== null && b !== null && a.r === b.r && a.c === b.c);
}

export function createBoard(
  wrap: HTMLElement,
  onToggle: (r: number, c: number) => void,
  options: BoardOptions = {},
): BoardView {
  const base = document.createElement('canvas');
  base.className = 'board-canvas';
  base.setAttribute('aria-label', '棋盘。方向键移动，回车翻转；右键或按住空格拖动，滚轮缩放。');
  const overlay = document.createElement('canvas');
  overlay.className = 'board-canvas board-overlay';
  wrap.append(base, overlay);

  const ctx = base.getContext('2d');
  const top = overlay.getContext('2d');
  if (ctx === null || top === null) throw new Error('当前浏览器不支持 Canvas 2D');

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let H = 0;
  let W = 0;
  let cssW = 0;
  let cssH = 0;
  let cells: CellState[] = [];
  let previousOn = new Uint8Array(0);
  let cellFrames = new Uint8Array(0);
  let activeCells = 0;
  let markFrames = new Uint8Array(0);
  let activeMarks = 0;

  let fit: View = { scale: 16, offsetX: 0, offsetY: 0 };
  let view: View = fit;
  let goal: View = fit;
  let zoom = 1;
  let easeFrames = 0;

  let mode: InteractionMode = 'setup';
  let enabled = true;
  let hover: { r: number; c: number } | null = null;
  let hoverAlpha = 0;
  let hoverTarget = 0;
  let pressed: { r: number; c: number } | null = null;
  let spaceDown = false;

  let gesture:
    | { kind: 'press'; id: number; cell: { r: number; c: number }; startX: number; startY: number }
    | { kind: 'pan'; id: number; lastX: number; lastY: number }
    | { kind: 'pinch'; gx: number; gy: number; lastDist: number }
    | null = null;

  /** 触屏上当前按着的手指。双指捏合、以及抬一指后的退化平移，都靠这张表。 */
  const pointers = new Map<number, { x: number; y: number }>();

  let ripples: Array<{ r: number; c: number; frames: number }> = [];
  let celebration: { r: number; c: number; frames: number } | null = null;

  let rafId = 0;
  let pendingDraw = false;
  let pendingOverlay = false;

  function syncCanvasSize(): void {
    const rect = wrap.getBoundingClientRect();
    cssW = Math.max(0, rect.width);
    cssH = Math.max(0, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const canvas of [base, overlay]) {
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    top.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function syncCursor(): void {
    wrap.classList.toggle('over-cell', enabled && hover !== null && gesture?.kind !== 'pan');
    wrap.classList.toggle('pan-ready', spaceDown && gesture?.kind !== 'pan');
  }

  function snapTo(next: View): void {
    view = next;
    goal = next;
    easeFrames = 0;
  }

  function easeTo(next: View): void {
    if (reducedMotion) {
      snapTo(next);
      requestDraw();
      return;
    }
    goal = next;
    easeFrames = 0;
    requestFrame();
  }

  function stopViewAnimation(): void {
    goal = view;
    easeFrames = 0;
  }

  function emitZoom(): void {
    options.onZoom?.(Math.round(zoom * 100));
  }

  function refit(keepAnchor: boolean): void {
    if (H === 0 || W === 0 || cssW === 0 || cssH === 0) return;
    fit = defaultView(cssW, cssH, W, H);
    const scale = fit.scale * zoom;
    const anchorX = cssW / 2;
    const anchorY = cssH / 2;
    const boardX = keepAnchor && view.scale > 0 ? (anchorX - view.offsetX) / view.scale : W / 2;
    const boardY = keepAnchor && view.scale > 0 ? (anchorY - view.offsetY) / view.scale : H / 2;
    snapTo(clampPan({ scale, offsetX: anchorX - boardX * scale, offsetY: anchorY - boardY * scale }, cssW, cssH, W, H));
  }

  function requestFrame(): void {
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(pump);
  }

  function requestDraw(): void {
    pendingDraw = true;
    requestFrame();
  }

  /** 只有悬浮层需要重画：不碰底格，大棋盘上鼠标扫过一排也不会重画 4096 个格子。 */
  function requestOverlay(): void {
    pendingOverlay = true;
    requestFrame();
  }

  function pump(): void {
    rafId = 0;
    let dirty = pendingDraw;
    let overlayOnly = pendingOverlay;
    pendingDraw = false;
    pendingOverlay = false;

    if (view !== goal) {
      easeFrames++;
      const next = {
        scale: view.scale + (goal.scale - view.scale) * ZOOM_EASE,
        offsetX: view.offsetX + (goal.offsetX - view.offsetX) * ZOOM_EASE,
        offsetY: view.offsetY + (goal.offsetY - view.offsetY) * ZOOM_EASE,
      };
      const settled =
        easeFrames >= ZOOM_FRAMES ||
        (Math.abs(goal.scale - next.scale) <= goal.scale * 0.002 &&
          Math.abs(goal.offsetX - next.offsetX) <= 0.35 &&
          Math.abs(goal.offsetY - next.offsetY) <= 0.35);
      view = settled ? goal : clampPan(next, cssW, cssH, W, H);
      if (settled) easeFrames = 0;
      dirty = true;
    }

    if (hoverAlpha !== hoverTarget) {
      hoverAlpha += (hoverTarget - hoverAlpha) * HOVER_EASE;
      if (Math.abs(hoverAlpha - hoverTarget) < 0.025) hoverAlpha = hoverTarget;
      if (hoverAlpha === 0 && hoverTarget === 0) hover = null;
      overlayOnly = true;
    }

    if (activeCells > 0) {
      for (let i = 0; i < cellFrames.length; i++) {
        if (cellFrames[i] === 0) continue;
        cellFrames[i]--;
        if (cellFrames[i] === 0) activeCells--;
      }
      dirty = true;
    }

    if (activeMarks > 0) {
      for (let i = 0; i < markFrames.length; i++) {
        if (markFrames[i] === 0) continue;
        markFrames[i]--;
        if (markFrames[i] === 0) activeMarks--;
      }
      dirty = true;
    }

    if (ripples.length > 0) {
      for (const ripple of ripples) ripple.frames--;
      ripples = ripples.filter((ripple) => ripple.frames > 0);
      overlayOnly = true;
    }

    if (celebration !== null) {
      celebration.frames--;
      if (celebration.frames <= 0) celebration = null;
      overlayOnly = true;
    }

    if (dirty) drawBase();
    if (dirty || overlayOnly) drawOverlay();

    if (
      view !== goal ||
      hoverAlpha !== hoverTarget ||
      activeCells > 0 ||
      activeMarks > 0 ||
      ripples.length > 0 ||
      celebration !== null
    ) requestFrame();
  }

  function cellColor(i: number, on: boolean): string {
    if (cellFrames[i] === 0) return on ? COLORS.on : COLORS.off;
    const raw = 1 - cellFrames[i] / CELL_FRAMES;
    const t = raw * raw * (3 - 2 * raw);
    const from = previousOn[i] === 1 ? ON_RGB : OFF_RGB;
    const to = on ? ON_RGB : OFF_RGB;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  function visibleBounds(scale: number): { r0: number; r1: number; c0: number; c1: number } {
    return {
      c0: Math.max(0, Math.floor(-view.offsetX / scale)),
      c1: Math.min(W - 1, Math.ceil((cssW - view.offsetX) / scale)),
      r0: Math.max(0, Math.floor(-view.offsetY / scale)),
      r1: Math.min(H - 1, Math.ceil((cssH - view.offsetY) / scale)),
    };
  }

  function drawBase(): void {
    ctx.clearRect(0, 0, cssW, cssH);
    if (H === 0 || W === 0) return;

    const scale = view.scale;
    const boardW = W * scale;
    const boardH = H * scale;
    const pad = Math.max(5, Math.min(12, scale * 0.42));

    ctx.fillStyle = COLORS.panel;
    roundRect(ctx, view.offsetX - pad, view.offsetY - pad, boardW + pad * 2, boardH + pad * 2, 12);
    ctx.fill();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.stroke();

    const gap = scale >= 7 ? Math.max(1, scale * 0.09) : scale >= 3.5 ? 0.5 : 0;
    const radius = scale >= 11 ? Math.min(5, scale * 0.2) : 0;
    const size = Math.max(0.7, scale - gap);
    const { r0, r1, c0, c1 } = visibleBounds(scale);

    for (let r = r0; r <= r1; r++) {
      const rowBase = r * W;
      for (let c = c0; c <= c1; c++) {
        const i = rowBase + c;
        const cell = cells[i];
        if (cell === undefined) continue;

        const isPressed = pressed !== null && pressed.r === r && pressed.c === c;
        const inset = isPressed ? Math.min(2, size * 0.06) : 0;
        const x = view.offsetX + c * scale + gap / 2 + inset;
        const y = view.offsetY + r * scale + gap / 2 + inset;
        const drawnSize = Math.max(0.7, size - inset * 2);

        ctx.fillStyle = cellColor(i, cell.on);
        if (radius > 0) {
          roundRect(ctx, x, y, drawnSize, drawnSize, Math.max(0, radius - inset));
          ctx.fill();
        } else {
          ctx.fillRect(x, y, drawnSize, drawnSize);
        }

        if (isPressed) {
          ctx.fillStyle = COLORS.press;
          roundRect(ctx, x, y, drawnSize, drawnSize, Math.max(0, radius - inset));
          ctx.fill();
        }

        if (cell.mark !== 'none' && drawnSize >= 3) {
          const progress = markFrames[i] > 0 ? 1 - markFrames[i] / MARK_FRAMES : 1;
          drawMark(x, y, drawnSize, cell.mark, cell.on, progress);
        }
      }
    }
  }

  function drawMark(x: number, y: number, size: number, mark: Mark, on: boolean, progress: number): void {
    const eased = progress >= 1 ? 1 : 1 - (1 - progress) ** 3;
    const cx = x + size / 2;
    const cy = y + size / 2;
    const wrong = mark === 'wrong';
    const radius = Math.max(1, size * (wrong ? 0.27 : 0.24) * (0.4 + 0.6 * eased));

    ctx.globalAlpha = eased;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = wrong ? COLORS.wrong : on ? COLORS.hitOn : COLORS.hit;
    ctx.fill();
    if (wrong && on) {
      ctx.strokeStyle = COLORS.halo;
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function affected(cell: { r: number; c: number }): Array<{ r: number; c: number }> {
    if (mode === 'setup') return [cell];
    const out = [{ r: cell.r, c: cell.c }];
    if (cell.r > 0) out.push({ r: cell.r - 1, c: cell.c });
    if (cell.r + 1 < H) out.push({ r: cell.r + 1, c: cell.c });
    if (cell.c > 0) out.push({ r: cell.r, c: cell.c - 1 });
    if (cell.c + 1 < W) out.push({ r: cell.r, c: cell.c + 1 });
    return out;
  }

  function drawOverlay(): void {
    top.clearRect(0, 0, cssW, cssH);
    if (H === 0 || W === 0) return;

    if (enabled && hover !== null && hoverAlpha > 0.01 && view.scale >= 5 && gesture?.kind !== 'pan') {
      top.globalAlpha = hoverAlpha;
      const s = view.scale;
      const focus = affected(hover);
      // 两遍绘制：先四邻（弱），再中心（强）。中心最后落笔，层级压在最上面，
      // 一眼就能看出「点这里」；设置模式只有一格，自然按中心样式画
      for (const centerPass of [false, true]) {
        for (const cell of focus) {
          const center = cell.r === hover.r && cell.c === hover.c;
          if (center !== centerPass) continue;
          const x = view.offsetX + cell.c * s;
          const y = view.offsetY + cell.r * s;
          if (center) {
            top.fillStyle = COLORS.hoverCenterFill;
            top.strokeStyle = COLORS.hoverCenterLine;
            top.lineWidth = 2;
            roundRect(top, x + 0.5, y + 0.5, s - 1, s - 1, Math.min(5, s * 0.22));
          } else {
            top.fillStyle = COLORS.hoverNeighborFill;
            top.strokeStyle = COLORS.hoverNeighborLine;
            top.lineWidth = 1;
            roundRect(top, x + 0.75, y + 0.75, s - 1.5, s - 1.5, Math.min(4, s * 0.18));
          }
          top.fill();
          top.stroke();
        }
      }
      top.globalAlpha = 1;
    }

    for (const ripple of ripples) {
      const progress = 1 - ripple.frames / RIPPLE_FRAMES;
      const x = view.offsetX + (ripple.c + 0.5) * view.scale;
      const y = view.offsetY + (ripple.r + 0.5) * view.scale;
      top.globalAlpha = (1 - progress) * 0.65;
      top.strokeStyle = COLORS.ripple;
      top.lineWidth = Math.max(1, view.scale * 0.045);
      top.beginPath();
      top.arc(x, y, view.scale * (0.18 + progress * 0.62), 0, Math.PI * 2);
      top.stroke();
    }
    top.globalAlpha = 1;

    if (celebration !== null) {
      const elapsed = CELEBRATE_FRAMES - celebration.frames;
      const scale = view.scale;
      const { r0, r1, c0, c1 } = visibleBounds(scale);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const distance = Math.hypot(r - celebration.r, c - celebration.c);
          const local = (elapsed - distance * 0.7) / 12;
          if (local <= 0 || local >= 1) continue;
          top.globalAlpha = Math.sin(local * Math.PI) * 0.42;
          top.fillStyle = COLORS.done;
          const gap = scale >= 7 ? Math.max(1, scale * 0.09) : 0;
          roundRect(top, view.offsetX + c * scale + gap / 2, view.offsetY + r * scale + gap / 2, scale - gap, scale - gap, Math.min(5, scale * 0.2));
          top.fill();
        }
      }
      top.globalAlpha = Math.min(1, celebration.frames / 12);
      top.strokeStyle = COLORS.done;
      top.lineWidth = 2;
      const pad = Math.max(5, Math.min(12, scale * 0.42));
      roundRect(top, view.offsetX - pad, view.offsetY - pad, W * scale + pad * 2, H * scale + pad * 2, 12);
      top.stroke();
      top.globalAlpha = 1;
    }
  }

  function setHover(next: { r: number; c: number } | null): void {
    if (next === null) {
      if (hoverTarget === 0) return;
      hoverTarget = 0;
    } else {
      if (hoverTarget === 1 && sameCell(hover, next)) return;
      hover = next;
      hoverTarget = 1;
    }
    syncCursor();
    // 关键：换格后必须置脏重画。只推进动画帧而不标记重绘的话，
    // hoverAlpha 落定为 1 后 pump 里没有任何分支会再画悬浮层，
    // 十字就冻在淡入结束时的位置 —— 这正是「不跟鼠标」的根源
    requestOverlay();
  }

  function localPoint(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = base.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function addRipple(r: number, c: number): void {
    if (reducedMotion) return;
    ripples.push({ r, c, frames: RIPPLE_FRAMES });
    if (ripples.length > 12) ripples.shift();
    requestFrame();
  }

  function setZoom(nextZoom: number, x: number, y: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    if (next === zoom) return;
    zoom = next;
    easeTo(clampPan(zoomAt(goal, fit.scale * zoom, x, y, fit.scale * MIN_ZOOM, fit.scale * MAX_ZOOM), cssW, cssH, W, H));
    emitZoom();
  }

  /**
   * 双指捏合：锚点是「手势开始时质心下的那格内容」，此后每次移动都把
   * 这个锚点放到当前质心上、按指距比例缩放 —— 缩放与平移由同一公式给出，
   * 不做增量累加，被边界夹取后往回捏也不会漂移。
   */
  function applyPinch(dist: number, cx: number, cy: number): void {
    if (gesture === null || gesture.kind !== 'pinch' || gesture.lastDist <= 0) return;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (dist / gesture.lastDist)));
    const nextScale = fit.scale * nextZoom;
    const next = clampPan(
      {
        scale: nextScale,
        offsetX: cx - gesture.gx * nextScale,
        offsetY: cy - gesture.gy * nextScale,
      },
      cssW,
      cssH,
      W,
      H,
    );
    if (nextZoom !== zoom) {
      zoom = nextZoom;
      emitZoom();
    }
    gesture.lastDist = dist;
    // 捏合必须跟手：直接落定，不走缓动
    snapTo(next);
    requestDraw();
  }

  base.addEventListener('wheel', (event) => {
    if (event.deltaY === 0 || W === 0 || H === 0) return;
    event.preventDefault();
    const { x, y } = localPoint(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    setZoom(zoom * Math.exp(-delta * 0.0015), x, y);
  }, { passive: false });

  base.addEventListener('contextmenu', (event) => event.preventDefault());

  base.addEventListener('pointerdown', (event) => {
    if (W === 0 || H === 0) return;
    if (event.pointerType === 'mouse' && event.button > 2) return;
    const point = localPoint(event);

    wrap.focus({ preventScroll: true });

    // ── 触屏 ─────────────────────────────────────────────
    if (event.pointerType === 'touch') {
      event.preventDefault();
      pointers.set(event.pointerId, point);

      // 触屏不 setPointerCapture：多指捏合时浏览器对指针捕获的行为不一致，
      // 捕获会吞掉第二根手指的 move/up 事件，捏合就永远触发不了。
      // 靠 .stage 的 touch-action:none 让整个手势期间事件都派发到 base 即可。

      if (pointers.size >= 2) {
        // 第二根（及更多）手指落下 = 导航意图：正在进行的落子整个取消，绝不落子
        pressed = null;
        setHover(null);
        const pts = [...pointers.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        stopViewAnimation();
        gesture = {
          kind: 'pinch',
          gx: (cx - view.offsetX) / view.scale,
          gy: (cy - view.offsetY) / view.scale,
          lastDist: Math.hypot(a.x - b.x, a.y - b.y),
        };
        wrap.classList.add('dragging');
        syncCursor();
        requestDraw();
        return;
      }

      const hit = cellAt(view, point.x, point.y, W, H);
      stopViewAnimation();
      if (enabled && hit !== null) {
        // 触屏没有先行悬停：按下即显示十字预览；轻点松手落子，滑过阈值则转平移
        pressed = hit;
        gesture = { kind: 'press', id: event.pointerId, cell: hit, startX: point.x, startY: point.y };
        setHover(hit);
        requestDraw();
        return;
      }
      // 指头落在棋盘外（棋盘小于画布时的留白）：按平移处理
      gesture = { kind: 'pan', id: event.pointerId, lastX: point.x, lastY: point.y };
      wrap.classList.add('dragging');
      syncCursor();
      return;
    }

    // ── 鼠标 / 触控笔 ─────────────────────────────────────
    base.setPointerCapture(event.pointerId);
    const hit = cellAt(view, point.x, point.y, W, H);
    const wantsPan =
      event.button === 1 ||
      event.button === 2 ||
      (event.button === 0 && (spaceDown || hit === null));

    stopViewAnimation();
    setHover(null);

    if (wantsPan) {
      event.preventDefault();
      gesture = { kind: 'pan', id: event.pointerId, lastX: point.x, lastY: point.y };
      wrap.classList.add('dragging');
      syncCursor();
      return;
    }

    if (!enabled || hit === null || event.button !== 0) {
      gesture = null;
      return;
    }
    pressed = hit;
    gesture = { kind: 'press', id: event.pointerId, cell: hit, startX: point.x, startY: point.y };
    requestDraw();
  });

  base.addEventListener('pointermove', (event) => {
    const point = localPoint(event);

    // ── 触屏：双指捏合 ───────────────────────────────
    if (gesture?.kind === 'pinch') {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, point);
      const pts = [...pointers.values()];
      if (pts.length < 2) return;
      const a = pts[0]!;
      const b = pts[1]!;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      applyPinch(Math.hypot(a.x - b.x, a.y - b.y), cx, cy);
      return;
    }

    if (gesture?.kind === 'pan' && gesture.id === event.pointerId) {
      // 触屏平移也同步记录位置，保证平移中落下第二指时捏合起点准确
      if (event.pointerType === 'touch') pointers.set(event.pointerId, point);
      const next = clampPan({
        scale: view.scale,
        offsetX: view.offsetX + point.x - gesture.lastX,
        offsetY: view.offsetY + point.y - gesture.lastY,
      }, cssW, cssH, W, H);
      view = next;
      goal = next;
      gesture.lastX = point.x;
      gesture.lastY = point.y;
      requestDraw();
      return;
    }

    const hit = cellAt(view, point.x, point.y, W, H);
    if (gesture?.kind === 'press' && gesture.id === event.pointerId) {
      // 触屏单指：位移超过阈值就升级为平移，不再算下棋。
      // 这是「滑动平移」与「点一下下棋」的分界，否则单指滑动时棋盘纹丝不动，
      // 用户会以为触屏失灵、棋盘像张图片。
      if (
        event.pointerType === 'touch' &&
        Math.hypot(point.x - gesture.startX, point.y - gesture.startY) > TOUCH_PAN_THRESHOLD
      ) {
        pressed = null;
        setHover(null);
        gesture = { kind: 'pan', id: event.pointerId, lastX: gesture.startX, lastY: gesture.startY };
        wrap.classList.add('dragging');
        syncCursor();
        // 立即按本次位移平移一次，避免「滑过阈值的那一下」被吞掉
        const next = clampPan({
          scale: view.scale,
          offsetX: view.offsetX + point.x - gesture.lastX,
          offsetY: view.offsetY + point.y - gesture.lastY,
        }, cssW, cssH, W, H);
        view = next;
        goal = next;
        gesture.lastX = point.x;
        gesture.lastY = point.y;
        requestDraw();
        return;
      }
      // 单指落子时同步记录位置：万一这根手指没松、第二指又落下，
      // 捏合起点才不会用一根早已挪走的手指的旧坐标
      if (event.pointerType === 'touch') pointers.set(event.pointerId, point);
      const nextPressed = sameCell(hit, gesture.cell) ? gesture.cell : null;
      if (!sameCell(pressed, nextPressed)) {
        pressed = nextPressed;
        requestDraw();
      }
      return;
    }
    setHover(enabled ? hit : null);
  });

  function endGesture(event: PointerEvent): void {
    if (gesture === null || gesture.id !== event.pointerId) return;
    const current = gesture;
    gesture = null;
    wrap.classList.remove('dragging');
    if (base.hasPointerCapture(event.pointerId)) base.releasePointerCapture(event.pointerId);

    if (current.kind === 'pan') {
      syncCursor();
      const point = localPoint(event);
      setHover(cellAt(view, point.x, point.y, W, H));
      return;
    }

    const point = localPoint(event);
    const hit = cellAt(view, point.x, point.y, W, H);
    const shouldToggle = pressed !== null && sameCell(hit, current.cell);
    pressed = null;
    requestDraw();
    setHover(hit);
    if (shouldToggle) {
      addRipple(current.cell.r, current.cell.c);
      onToggle(current.cell.r, current.cell.c);
    }
  }

  /**
   * 触屏手指抬起 / 取消。双指捏合抬起一根后，退化为单指平移继续跟手，
   * 而不是整个结束 —— 这是触屏上「捏合 → 顺手拖动」流畅感的来源。
   */
  function endTouch(event: PointerEvent, cancelled: boolean): void {
    pointers.delete(event.pointerId);

    if (gesture?.kind === 'pinch') {
      if (pointers.size >= 2) {
        // 还有两根指头在：继续捏合（用剩余两根重新量距）
        const pts = [...pointers.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        gesture.gx = (cx - view.offsetX) / view.scale;
        gesture.gy = (cy - view.offsetY) / view.scale;
        gesture.lastDist = Math.hypot(a.x - b.x, a.y - b.y);
        return;
      }
      // 只剩一根：捏合退化为平移，从当前手指位置继续拖
      if (pointers.size === 1) {
        const last = [...pointers.values()][0]!;
        gesture = { kind: 'pan', id: [...pointers.keys()][0]!, lastX: last.x, lastY: last.y };
        syncCursor();
        return;
      }
      // 全部抬起
      gesture = null;
      wrap.classList.remove('dragging');
      syncCursor();
      requestDraw();
      return;
    }

    // 单指落子 / 平移手势：只处理与手势匹配的那根手指
    if (gesture === null || gesture.id !== event.pointerId) return;
    const current = gesture;
    gesture = null;
    wrap.classList.remove('dragging');
    if (base.hasPointerCapture(event.pointerId)) base.releasePointerCapture(event.pointerId);

    if (current.kind === 'pan') {
      syncCursor();
      const point = localPoint(event);
      setHover(cellAt(view, point.x, point.y, W, H));
      return;
    }

    // press：松手同格才落子（滑开即取消）
    if (cancelled) {
      pressed = null;
      syncCursor();
      requestDraw();
      return;
    }
    const point = localPoint(event);
    const hit = cellAt(view, point.x, point.y, W, H);
    const shouldToggle = pressed !== null && sameCell(hit, current.cell);
    pressed = null;
    requestDraw();
    setHover(hit);
    if (shouldToggle) {
      addRipple(current.cell.r, current.cell.c);
      onToggle(current.cell.r, current.cell.c);
    }
  }

  base.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') endTouch(event, false);
    else endGesture(event);
  });
  base.addEventListener('pointercancel', (event) => {
    if (event.pointerType === 'touch') endTouch(event, true);
    else if (gesture !== null && gesture.id === event.pointerId) {
      gesture = null;
      pressed = null;
      wrap.classList.remove('dragging');
      syncCursor();
      requestDraw();
    }
  });
  base.addEventListener('pointerleave', () => {
    if (gesture === null) setHover(null);
  });

  wrap.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null | undefined;
    if (target != null && target.closest('button, input, select, textarea') !== null) return;
    if (event.key === ' ') {
      event.preventDefault();
      spaceDown = true;
      syncCursor();
      return;
    }
    if (H === 0 || W === 0) return;
    if (event.key === 'Enter') {
      if (!enabled || hover === null) return;
      event.preventDefault();
      addRipple(hover.r, hover.c);
      onToggle(hover.r, hover.c);
      return;
    }
    if (!enabled) return;
    const delta = event.key === 'ArrowUp' ? [-1, 0]
      : event.key === 'ArrowDown' ? [1, 0]
        : event.key === 'ArrowLeft' ? [0, -1]
          : event.key === 'ArrowRight' ? [0, 1]
            : null;
    if (delta === null) return;
    event.preventDefault();
    const current = hover ?? { r: Math.floor(H / 2), c: Math.floor(W / 2) };
    setHover({
      r: Math.min(H - 1, Math.max(0, current.r + delta[0])),
      c: Math.min(W - 1, Math.max(0, current.c + delta[1])),
    });
  });

  wrap.addEventListener('keyup', (event) => {
    if (event.key !== ' ') return;
    spaceDown = false;
    syncCursor();
  });
  wrap.addEventListener('blur', () => {
    spaceDown = false;
    syncCursor();
  });

  new ResizeObserver(() => {
    const before = cssW * cssH;
    syncCanvasSize();
    if (before !== cssW * cssH) refit(true);
    requestDraw();
  }).observe(wrap);

  function writeCell(i: number, state: CellState): void {
    const prev = cells[i];
    cells[i] = state;
    if (prev !== undefined && prev.on !== state.on && !reducedMotion) {
      previousOn[i] = prev.on ? 1 : 0;
      if (cellFrames[i] === 0) activeCells++;
      cellFrames[i] = CELL_FRAMES;
    }
    if (state.mark !== 'none' && (prev === undefined || prev.mark === 'none') && !reducedMotion) {
      if (markFrames[i] === 0) activeMarks++;
      markFrames[i] = MARK_FRAMES;
    }
  }

  return {
    reset(h, w, state) {
      H = h;
      W = w;
      cells = new Array(h * w);
      previousOn = new Uint8Array(h * w);
      cellFrames = new Uint8Array(h * w);
      activeCells = 0;
      markFrames = new Uint8Array(h * w);
      activeMarks = 0;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) cells[r * w + c] = state(r, c);
      }
      hover = null;
      hoverAlpha = 0;
      hoverTarget = 0;
      pressed = null;
      gesture = null;
      ripples = [];
      celebration = null;
      zoom = 1;
      syncCanvasSize();
      refit(false);
      emitZoom();

      const target = goal;
      if (!reducedMotion) {
        const settled = target.scale * SETTLE;
        view = {
          scale: settled,
          offsetX: cssW / 2 - (W * settled) / 2,
          offsetY: cssH / 2 - (H * settled) / 2,
        };
        easeTo(target);
      }
      drawBase();
      drawOverlay();
    },

    paint(r, c, state) {
      if (r < 0 || r >= H || c < 0 || c >= W) return;
      writeCell(r * W + c, state);
      requestDraw();
    },

    repaint(state) {
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) writeCell(r * W + c, state(r, c));
      }
      requestDraw();
    },

    resetView() {
      if (H === 0 || W === 0) return;
      zoom = 1;
      fit = defaultView(cssW, cssH, W, H);
      easeTo(fit);
      emitZoom();
    },

    zoomBy(factor) {
      setZoom(zoom * factor, cssW / 2, cssH / 2);
    },

    setInteraction(nextMode, nextEnabled) {
      mode = nextMode;
      enabled = nextEnabled;
      if (!enabled) {
        pressed = null;
        setHover(null);
      }
      syncCursor();
      requestDraw();
    },

    celebrate(r, c) {
      if (reducedMotion) return;
      celebration = { r, c, frames: CELEBRATE_FRAMES };
      requestFrame();
    },
  };
}
