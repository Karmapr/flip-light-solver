/**
 * 装配层：把状态机、棋盘视图、结果面板和三组按钮连起来。
 *
 * 这里不包含任何规则或求解逻辑 —— 只做三件事：
 *   1. 把 DOM 事件翻译成状态机调用
 *   2. 把状态机的变化画出来
 *   3. 丢弃过期的求解结果（epoch 守卫）
 */

import { Session, type Goal, type Mode } from './ui/state.ts';
import { createBoard } from './ui/board.ts';
import { createResult } from './ui/result.ts';
import type { SolveResponse } from './solver.worker.ts';

const session = new Session();

const boardRoot = document.querySelector<HTMLElement>('#board-wrap')!;
const resultRoot = document.querySelector<HTMLElement>('#result')!;
const rowsInput = document.querySelector<HTMLInputElement>('#rows')!;
const colsInput = document.querySelector<HTMLInputElement>('#cols')!;
const applyButton = document.querySelector<HTMLButtonElement>('#apply')!;
const allOffButton = document.querySelector<HTMLButtonElement>('#all-off')!;
const allOnButton = document.querySelector<HTMLButtonElement>('#all-on')!;
const randomSolvableButton = document.querySelector<HTMLButtonElement>('#random-solvable')!;
const randomAnyButton = document.querySelector<HTMLButtonElement>('#random-any')!;
const modeGroup = document.querySelector<HTMLElement>('#mode')!;
const goalGroup = document.querySelector<HTMLElement>('#goal')!;
const budgetInput = document.querySelector<HTMLInputElement>('#budget')!;
const solveButton = document.querySelector<HTMLButtonElement>('#solve')!;
const resetViewButton = document.querySelector<HTMLButtonElement>('#view-reset')!;
const zoomOutButton = document.querySelector<HTMLButtonElement>('#zoom-out')!;
const zoomInButton = document.querySelector<HTMLButtonElement>('#zoom-in')!;
const zoomLevel = document.querySelector<HTMLElement>('#zoom-level')!;
const playStatus = document.querySelector<HTMLElement>('#play-status')!;

const board = createBoard(boardRoot, onClick, {
  onZoom(percent) {
    zoomLevel.textContent = `${percent}%`;
  },
});
const panel = createResult(resultRoot);

// 构建脚本会把 .ts 改写成 .js，所以这里直接写 .js
const worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });

function paintCell(r: number, c: number): void {
  board.paint(r, c, session.cellState(r, c));
}

function repaintBoard(): void {
  board.repaint((r, c) => session.cellState(r, c));
}

function renderPanel(): void {
  panel.render(session.panel());
}

function onClick(r: number, c: number): void {
  const outcome = session.click(r, c);
  if (outcome.full) {
    repaintBoard();
  } else {
    for (const cell of outcome.cells) paintCell(cell.r, cell.c);
    // 方案变化只影响被点的那一格，但它可能在标记与普通之间切换
    paintCell(r, c);
  }
  syncControls();
  renderPanel();
  if (session.phase === 'done') board.celebrate(r, c);
}

/** 尺寸变化后重建网格，并把输入框拉回到实际生效的值。 */
function rebuildGrid(): void {
  board.reset(session.H, session.W, (r, c) => session.cellState(r, c));
  rowsInput.value = String(session.H);
  colsInput.value = String(session.W);
  syncControls();
  renderPanel();
}

function syncControls(): void {
  const solving = session.phase === 'solving';
  const guiding = session.phase === 'guiding';

  board.setInteraction(session.mode, !solving);
  boardRoot.dataset.phase = session.phase;
  playStatus.textContent = solving
    ? '正在求解'
    : guiding
      ? `解题引导 · 还剩 ${session.remaining} 步`
      : session.phase === 'done'
        ? '已完成'
        : session.mode === 'setup'
          ? '设置盘面'
          : '自由游玩';

  for (const button of modeGroup.querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === session.mode));
    button.disabled = solving;
  }
  for (const button of goalGroup.querySelectorAll<HTMLButtonElement>('button[data-goal]')) {
    button.setAttribute('aria-pressed', String(button.dataset.goal === session.goal));
    button.disabled = solving;
  }

  applyButton.disabled = solving;
  allOffButton.disabled = solving;
  allOnButton.disabled = solving;
  randomSolvableButton.disabled = solving;
  randomAnyButton.disabled = solving;
  budgetInput.disabled = solving;
  solveButton.disabled = solving;
  solveButton.textContent = guiding ? '重新求解' : '求解';
}

applyButton.addEventListener('click', () => {
  session.resize(Number(rowsInput.value), Number(colsInput.value));
  rebuildGrid();
});

resetViewButton.addEventListener('click', () => board.resetView());
zoomOutButton.addEventListener('click', () => board.zoomBy(1 / 1.25));
zoomInButton.addEventListener('click', () => board.zoomBy(1.25));

for (const input of [rowsInput, colsInput]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyButton.click();
  });
}

allOffButton.addEventListener('click', () => {
  session.fill(false);
  repaintBoard();
  syncControls();
  renderPanel();
});

allOnButton.addEventListener('click', () => {
  session.fill(true);
  repaintBoard();
  syncControls();
  renderPanel();
});

randomSolvableButton.addEventListener('click', () => {
  session.randomSolvable();
  repaintBoard();
  syncControls();
  renderPanel();
});

randomAnyButton.addEventListener('click', () => {
  session.randomAny();
  repaintBoard();
  syncControls();
  renderPanel();
});

modeGroup.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-mode]');
  if (button === null) return;
  session.setMode(button.dataset.mode as Mode);
  repaintBoard();
  syncControls();
  renderPanel();
});

goalGroup.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-goal]');
  if (button === null) return;
  session.setGoal(button.dataset.goal as Goal);
  repaintBoard();
  syncControls();
  renderPanel();
});

budgetInput.addEventListener('input', () => {
  session.setBudgetSeconds(Number(budgetInput.value));
});

budgetInput.addEventListener('change', () => {
  budgetInput.value = String(session.budgetSeconds);
});

solveButton.addEventListener('click', () => {
  const request = session.beginSolve();
  if (request === null) return;
  worker.postMessage(request);
  repaintBoard();
  syncControls();
  renderPanel();
});

worker.onmessage = (event: MessageEvent<SolveResponse>) => {
  const message = event.data;

  if (!message.ok) {
    if (!session.failSolve(message.id)) return;
    panel.fail(message.error);
    syncControls();
    return;
  }

  if (!session.acceptResult(message.id, message.result)) return; // 过期结果
  repaintBoard();
  syncControls();
  renderPanel();
};

session.resize(5, 5);
rebuildGrid();
