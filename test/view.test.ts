/**
 * 视图变换：缩放锚点、平移夹取、坐标反算。
 *
 * 这三件事都是「写错了不会报错，但用户会觉得界面在乱跑」的类型，
 * 所以用纯函数写、单独测，不依赖任何浏览器 API。
 */

import test from 'node:test';
import assert from 'node:assert';
import { cellAt, clampPan, DEFAULT_CELL, defaultView, MAX_ZOOM, MIN_ZOOM, zoomAt, type View } from '../src/ui/view.ts';

test('defaultView：小尺寸用固定格宽，大尺寸才缩到刚好放下', () => {
  const cssW = 900;
  const cssH = 600;

  // 小盘：格宽固定，绝不铺满
  for (const [W, H] of [[3, 3], [5, 5]]) {
    const view = defaultView(cssW, cssH, W, H);
    assert.equal(view.scale, DEFAULT_CELL, `${W}×${H} 应当用固定格宽`);
    assert.ok(W * view.scale < cssW, `${W}×${H} 不该铺满宽度`);
  }

  // 大盘：缩到装得下，且仍然居中
  for (const [W, H] of [[8, 8], [30, 30], [64, 64], [64, 10], [10, 64]]) {
    const view = defaultView(cssW, cssH, W, H);
    const boardW = W * view.scale;
    const boardH = H * view.scale;

    assert.ok(boardW <= cssW, `${W}×${H} 宽度溢出：${boardW} > ${cssW}`);
    assert.ok(boardH <= cssH, `${W}×${H} 高度溢出：${boardH} > ${cssH}`);
    assert.ok(Math.abs(view.offsetX * 2 + boardW - cssW) < 1e-9, `${W}×${H} 未水平居中`);
    assert.ok(Math.abs(view.offsetY * 2 + boardH - cssH) < 1e-9, `${W}×${H} 未垂直居中`);
    assert.ok(view.scale >= 1, `${W}×${H} 的格边长过小：${view.scale}`);
  }
});

test('zoomAt：锚点下的那一格在缩放前后必须停在原地', () => {
  const start: View = { scale: 10, offsetX: 50, offsetY: 30 };

  for (const [px, py] of [[0, 0], [250, 180], [400, 260], [899, 599]]) {
    for (const factor of [0.5, 1.3, 4, 20]) {
      const next = zoomAt(start, start.scale * factor, px, py, 1, 400);

      // 锚点处对应的棋盘坐标在缩放前后必须一致
      const before = {
        x: (px - start.offsetX) / start.scale,
        y: (py - start.offsetY) / start.scale,
      };
      const after = {
        x: (px - next.offsetX) / next.scale,
        y: (py - next.offsetY) / next.scale,
      };

      assert.ok(Math.abs(before.x - after.x) < 1e-9, `x 漂移：${before.x} -> ${after.x}`);
      assert.ok(Math.abs(before.y - after.y) < 1e-9, `y 漂移：${before.y} -> ${after.y}`);
    }
  }
});

test('zoomAt：缩放倍率被夹在给定区间内', () => {
  const start: View = { scale: 10, offsetX: 0, offsetY: 0 };

  const tooBig = zoomAt(start, 1e6, 100, 100, 10 * MIN_ZOOM, 10 * MAX_ZOOM);
  assert.equal(tooBig.scale, 10 * MAX_ZOOM);

  const tooSmall = zoomAt(start, 1e-6, 100, 100, 10 * MIN_ZOOM, 10 * MAX_ZOOM);
  assert.equal(tooSmall.scale, 10 * MIN_ZOOM);
});

test('clampPan：棋盘比画布小时始终居中', () => {
  const W = 8;
  const H = 8;
  const view: View = { scale: 10, offsetX: -9999, offsetY: 9999 };
  const out = clampPan(view, 800, 600, W, H);

  assert.equal(out.offsetX, (800 - W * 10) / 2);
  assert.equal(out.offsetY, (600 - H * 10) / 2);
});

test('clampPan：棋盘比画布大时，棋盘永远盖满画布，拖动拖不出去', () => {
  const W = 64;
  const H = 64;
  const cssW = 800;
  const cssH = 600;

  // 往各个方向猛拖，结果都必须让棋盘盖住整个画布：不留空白，也就没有「棋盘被拖丢」的余地
  for (const [dx, dy] of [[-1e6, -1e6], [1e6, 1e6], [-1e6, 1e6], [1e6, -1e6], [0, 0]]) {
    const out = clampPan({ scale: 40, offsetX: dx, offsetY: dy }, cssW, cssH, W, H);

    assert.ok(out.offsetX <= 0, `左边露白：${out.offsetX}`);
    assert.ok(out.offsetX + W * out.scale >= cssW, '右边露白');
    assert.ok(out.offsetY <= 0, `上边露白：${out.offsetY}`);
    assert.ok(out.offsetY + H * out.scale >= cssH, '下边露白');
  }
});

test('clampPan：刚过适配尺寸时两个方向各自独立判断', () => {
  const cssW = 800;
  const cssH = 600;

  // 宽 64 格、高 4 格：横向装不下，纵向装得下 → 横向可拖，纵向居中
  const out = clampPan({ scale: 40, offsetX: -500, offsetY: 9999 }, cssW, cssH, 64, 4);
  assert.equal(out.offsetX, -500, '横向应当保持原位');
  assert.equal(out.offsetY, (cssH - 4 * 40) / 2, '纵向应当强制居中');
});

test('cellAt：缩放平移之后仍然算得对格子', () => {
  const W = 6;
  const H = 4;
  const view: View = { scale: 25, offsetX: 40, offsetY: 100 };

  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // 取格子中心点，避开边界取整的歧义
      const px = view.offsetX + (c + 0.5) * view.scale;
      const py = view.offsetY + (r + 0.5) * view.scale;
      assert.deepEqual(cellAt(view, px, py, W, H), { r, c }, `(${r},${c}) 反算错误`);
    }
  }

  assert.equal(cellAt(view, 0, 0, W, H), null, '棋盘外应返回 null');
  assert.equal(cellAt(view, 39.9, 100, W, H), null, '左边界外应返回 null');
});
