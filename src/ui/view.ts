/**
 * 视图变换：棋盘坐标 ↔ 画布坐标。
 *
 * 全部是纯函数，不碰 DOM，也不认识任何棋盘状态 —— 所以可以直接测。
 * 视图只有三样东西：每格边长 scale、棋盘左上角在画布里的位置 offsetX/offsetY。
 */

export interface View {
  /** 每格边长（CSS px）。 */
  readonly scale: number;
  /** 棋盘左上角在画布中的横坐标（CSS px）。 */
  readonly offsetX: number;
  /** 棋盘左上角在画布中的纵坐标（CSS px）。 */
  readonly offsetY: number;
}

/** 相对「默认视图」的缩放范围。 */
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 24;

/**
 * 每格默认边长（CSS px）。
 *
 * 默认视图不铺满窗口，而是按这个尺寸画 —— 5×5 的盘铺满一整屏时每格上百像素，
 * 看着像放大的样品而不是棋盘。只有棋盘大到装不下时才按可用空间收缩。
 */
export const DEFAULT_CELL = 76;

/**
 * 棋盘比画布大时，拖动允许的过冲量。
 *
 * 取 0：棋盘的边永远不会越过画布的边，也就是永远拖不出去 —— 只能把棋盘内部
 * 挪到视野里。任何大于 0 的值都会让「边缘处留一块空白」成为可能，而空白一旦
 * 出现，用户就会以为棋盘被拖丢了。
 */
export const PAN_OVERSCROLL = 0;

/** 默认视图：固定格宽，居中；棋盘装不下时缩到刚好放下。 */
export function defaultView(cssW: number, cssH: number, W: number, H: number, padding = 28): View {
  const availW = Math.max(cssW - padding * 2, 1);
  const availH = Math.max(cssH - padding * 2, 1);
  const scale = Math.max(1, Math.min(DEFAULT_CELL, availW / W, availH / H));
  return {
    scale,
    offsetX: (cssW - W * scale) / 2,
    offsetY: (cssH - H * scale) / 2,
  };
}

/**
 * 以画布上的某一点为锚点缩放：锚点下面的那一格必须保持不动。
 * 这是「滚轮缩放」不晕的关键 —— 否则缩放时棋盘会往左上角跑。
 */
export function zoomAt(
  view: View,
  scale: number,
  px: number,
  py: number,
  minScale: number,
  maxScale: number,
): View {
  const next = Math.min(maxScale, Math.max(minScale, scale));
  if (next === view.scale) return view;
  const boardX = (px - view.offsetX) / view.scale;
  const boardY = (py - view.offsetY) / view.scale;
  return {
    scale: next,
    offsetX: px - boardX * next,
    offsetY: py - boardY * next,
  };
}

/**
 * 单轴夹取：
 *   棋盘该方向装得下 → 强制居中（拖不动，也没有拖的意义）
 *   棋盘该方向装不下 → 棋盘必须盖满画布，不允许露出空白
 */
function clampAxis(offset: number, boardSize: number, cssSize: number, overscroll: number): number {
  if (boardSize <= cssSize) return (cssSize - boardSize) / 2;
  const min = cssSize - boardSize - overscroll;
  return Math.min(overscroll, Math.max(min, offset));
}

/** 夹住平移，两个方向各自独立判断。 */
export function clampPan(
  view: View,
  cssW: number,
  cssH: number,
  W: number,
  H: number,
  overscroll = PAN_OVERSCROLL,
): View {
  return {
    scale: view.scale,
    offsetX: clampAxis(view.offsetX, W * view.scale, cssW, overscroll),
    offsetY: clampAxis(view.offsetY, H * view.scale, cssH, overscroll),
  };
}

/** 画布坐标 → 格子坐标；落在棋盘外返回 null。 */
export function cellAt(
  view: View,
  px: number,
  py: number,
  W: number,
  H: number,
): { r: number; c: number } | null {
  const c = Math.floor((px - view.offsetX) / view.scale);
  const r = Math.floor((py - view.offsetY) / view.scale);
  if (c < 0 || c >= W || r < 0 || r >= H) return null;
  return { r, c };
}
