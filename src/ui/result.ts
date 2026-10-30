/**
 * 结果面板。
 *
 * 核心职责是「不撒谎」：
 * OPTIMAL 与 FEASIBLE_UNPROVEN 必须一眼可辨；超时必须说明检查覆盖了多少；
 * 点错时必须给出「多花了多少次」这个确定的数字，而不是含糊的「可能不是最优」。
 */

import type { PanelModel } from './state.ts';

export interface ResultView {
  render(model: PanelModel): void;
  fail(message: string): void;
}

const numberFormat = new Intl.NumberFormat('zh-CN');

function row(dl: HTMLElement, key: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

function note(text: string, tone?: 'warn' | 'bad'): HTMLElement {
  const p = document.createElement('p');
  p.className = `result-note${tone === undefined ? '' : ` ${tone}`}`;
  p.textContent = text;
  return p;
}

export function createResult(root: HTMLElement): ResultView {
  return {
    fail(message) {
      root.className = 'result bad';
      root.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = '求解失败';
      root.append(title, note(message));
    },

    render(model) {
      root.replaceChildren();

      if (model.kind === 'idle') {
        root.className = 'result';
        return;
      }

      if (model.kind === 'solving') {
        root.className = 'result pending';
        root.textContent = '求解中…';
        return;
      }

      if (model.kind === 'unsolvable') {
        root.className = 'result bad';
        const title = document.createElement('strong');
        title.textContent = '无解';
        root.append(
          title,
          note('这个盘面无法通过任何点击组合达到目标（由线性方程组判定，不是超时）。'),
        );
        const detail = document.createElement('dl');
        detail.className = 'result-detail';
        row(detail, '解的总数', '0');
        if (model.result !== null) {
          row(detail, '零空间维数 d', String(model.result.nullity));
          row(detail, '耗时', `${model.result.elapsedMs.toFixed(0)} ms`);
        }
        root.append(detail);
        return;
      }

      const result = model.result;
      const proven = result?.optimalProven ?? true;
      const tone = model.kind === 'done' ? (result !== null && !proven ? 'warn' : 'good') : proven ? 'good' : 'warn';
      root.className = `result ${tone}`;

      const title = document.createElement('strong');
      if (model.kind === 'done') {
        title.textContent = '完成';
      } else if (proven) {
        title.textContent = '最优解';
      } else {
        title.textContent = '可行解（未证明最优）';
      }

      const head = document.createElement('div');
      head.className = 'result-head';
      const count = document.createElement('span');
      count.className = 'result-count';
      const big = model.kind === 'done' ? model.used : model.remaining;
      count.textContent = numberFormat.format(big);
      const unit = document.createElement('span');
      unit.textContent = model.kind === 'done' ? '次点击完成' : '次点击待做';
      head.append(count, unit);

      root.append(title, head);

      if (model.kind === 'done' && model.optimum !== null) {
        if (model.used > model.optimum) {
          root.append(
            note(`最优只需 ${numberFormat.format(model.optimum)} 次，多花的 ${numberFormat.format(model.used - model.optimum)} 次来自点错的格子。`),
          );
        } else {
          root.append(note('与最优方案完全一致。'));
        }
      }

      if (model.wrong > 0 && model.kind === 'guiding') {
        root.append(
          note(`点错了 ${numberFormat.format(model.wrong)} 个格子，总共会多花 ${numberFormat.format(model.wrong * 2)} 次。红色格子再点一次即可撤回。`, 'bad'),
        );
      }

      if (result !== null && !result.optimalProven && result.timedOut) {
        const total = result.total;
        const pct = total > 0 ? (result.checked / total) * 100 : 0;
        const human = pct < 0.01 ? '<0.01' : pct.toFixed(2);
        root.append(
          note(
            `搜索在时限内只检查了 ${human}% 的组合（${result.checked.toLocaleString('zh-CN')} / ${total.toLocaleString('zh-CN')}），更少点击数的解可能存在。`,
            'warn',
          ),
        );
      }

      const detail = document.createElement('dl');
      detail.className = 'result-detail';
      if (model.kind === 'guiding' || model.kind === 'done') {
        row(detail, '已点', numberFormat.format(model.used));
        if (model.optimum !== null) row(detail, '原最优', numberFormat.format(model.optimum));
      }
      if (result !== null) {
        row(detail, '解的总数', numberFormat.format(result.solutionCount));
        row(detail, '零空间维数 d', String(result.nullity));
        row(detail, '后端', result.method);
        row(detail, '耗时', `${result.elapsedMs.toFixed(0)} ms`);
      }
      root.append(detail);
    },
  };
}
