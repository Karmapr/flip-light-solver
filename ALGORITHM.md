# ALGORITHM.md — 翻转灯谜（Lights Out）精确最少点击求解器

> 本文是可直接据以实现、测试和优化的算法规范，而不是泛泛的解题介绍。
>
> **目标：** 对任意非空 `H × W` 矩形棋盘、标准十字翻转规则，判断有无解；有解时找到**全棋盘点击总次数最少**的方案，并且正确标识最优性是否已被证明。
>
> **精确性承诺：** 线性代数步骤是精确的。穷举、完整分支限界或返回 `OPTIMAL` 的约束优化器能够证明全局最优；带时间/节点限制而未完成证明时，只能返回 `FEASIBLE_UNPROVEN`。不存在已知对所有此类输入都最快的通用实现，不得声称任何启发式必然提高速度。

## 1. 问题约定与接口

- 棋盘尺寸为正整数 `H, W`，元素 `0=灭`、`1=亮`。
- 点击 `(r,c)` 翻转自身及存在的上下左右四邻居；越界邻居忽略；点击顺序无关，同一格点击两次互相抵消。
- **只需输出每格点击零次或一次**：点击两次不会影响结果但会增加次数。
- 最小化全部 `H*W` 个格子的点击数，不是最小化第一行点击数。
- 所有代数运算在 `GF(2)` 上进行：加减法均为 `XOR`。
- 输入必须校验：非空、各行等长、值严格为 `0` 或 `1`；不合法输入应抛出参数错误，不是返回“无解”。
- 推荐 API：`prepare(H, W) -> Geometry`（可缓存）；`solve(board, *, mode="auto", time_limit=None, node_limit=None) -> Result`。

`Result` 的推荐字段：

```text
status: "UNSOLVABLE" | "OPTIMAL" | "FEASIBLE_UNPROVEN"
solvable: boolean
optimal_proven: boolean
clicks: H×W 的 0/1 矩阵 | null
click_count: integer | null
solution_count: integer         # 无解为 0，有解为 2^d
rank: integer                   # 第一行映射矩阵的秩
nullity: integer                # d = w - rank
method: string                  # unique / gray / fwht / branch_bound / cp_sat
stats: optional                 # 用时、搜索节点、剪枝量等
```

`UNSOLVABLE` 必须由精确线性系统判定。`FEASIBLE_UNPROVEN` 也必须附带一个经过模拟校验的可行解。默认不设置预算时，内置算法必须一直搜索至最优性得到证明；切勿静默将近似解标为最优解。

## 2. 核心优化：先转置，使“第一行”沿短边

令

```text
h = max(H, W)
w = min(H, W)
N = h*w
```

若原始 `W > H`，先转置棋盘；在转置后的 `h×w` 棋盘上向下追灯；最终把点击方案转置回原方向。

**理由：** 十字翻转规则在转置下不变；向下追灯只需要决定长度为 `w` 的第一行，减少矩阵规模及自由变量的理论上界。转置不会改变可解性、解总数或最少点击次数。

全文使用转置后尺寸 `h≥w≥1`，行列索引从 0 开始。

## 3. 位运算表示与追灯递推

使用一个非负整数的低 `w` 位表示棋盘的一行（第 `c` 位为第 `c` 列）。整个点击方案使用一个非负整数的低 `N` 位表示，格子 `(r,c)` 对应位 `r*w+c`。

定义仅影响**同一行**的操作：

\[
A(x)=x\oplus((x\ll1)\land(2^w-1))\oplus(x\gg1).
\]

给定初始亮灯行 `b[0..h-1]` 和任意第一行点击向量 `p[0]=x`，后续点击行被唯一确定：

\[
p_{-1}=0,\qquad
p_{r+1}=b_r\oplus p_{r-1}\oplus A(p_r),\quad 0\le r<h.
\]

这里计算出的 `p_h` **不是可以点击的第 h 行**，而是最末行尚未消除的残留状态。只有 `p_h=0` 时，完整点击方案 `p_0..p_{h-1}` 才是有效解。

**正确且无歧义的基础原语：**

```python
def chase(top: int, b: list[int], h: int, w: int) -> tuple[int, int]:
    """返回 (完整点击位图, 最后一行残留)。b 的长度为 h。"""
    mask = (1 << w) - 1
    previous, current = 0, top
    clicks = 0
    for r in range(h):
        clicks |= current << (r * w)
        horizontal = current ^ ((current << 1) & mask) ^ (current >> 1)
        next_row = b[r] ^ previous ^ horizontal
        previous, current = current, next_row
    return clicks, current  # current 是残留 p_h，非实际点击行
```

该实现统一处理 `h=1`、`w=1`、边界单元及任意矩形棋盘。必须对 `top` 和每个 `b[r]` 保持 `w` 位有效；不能在最后一行之外实际点击。

## 4. 构造线性系统（几何结构只预处理一次）

### 4.1 第一行到最后残留的线性映射

固定尺寸后，记 `L : GF(2)^w -> GF(2)^w` 为在**全灭棋盘**上指定第一行点击、追灯后的残留映射。

对每个 `c=0..w-1`，计算：

```text
v_c = chase(1 << c, [0]*h, h, w).residue
M 的第 c 列 = v_c
```

得到 `w×w` 二进制矩阵 `M`。可用长度为 `w` 的整数数组 `M_rows[r]` 保存矩阵，每个整数的第 `c` 位表示 `M[r,c]`。

**更精简的生成方式（建议使用）：** 无须构造完整的点击位图。对于基向量 `e_c=1<<c`，从 `prev=0, curr=e_c` 出发执行恰好 `h` 次：

```python
prev, curr = 0, 1 << c
for _ in range(h):
    prev, curr = curr, prev ^ A(curr)
v_c = curr
```

这是 `M` 的一列。预计算取决于 `(h,w)`，与初始棋盘状态无关。

### 4.2 原始谜面转为 GF(2) 方程组

对实际初始棋盘执行 `chase(0,b)`，设残留为 `s`。对于任意第一行点击 `x`，残留恰为：

\[
\operatorname{residue}(x,b)=s\oplus Mx.
\]

因此有效解的充要条件是：

\[
\boxed{Mx=s\pmod2}.
\]

注意这里的“目标残留”是 `s`；右侧不是 `0`，除非初始谜面直接追灯后的残留恰为 `0`。

### 4.3 带行变换矩阵的 GF(2) 高斯—约旦消元

对固定的 `M` 只进行一次消元；同时维护初始为单位阵的 `E`，使最终满足：

\[
R=EM.
\]

行交换和行异或必须对 `R`、`E` **同步**执行。选主元时逐列从左向右找可用行，消去该列的其他所有行，得到行最简形（RREF），记录 `pivots[0..r-1]` 和 `rank=r`。无主元的列是自由列。

```text
R = copy(M_rows)
E[i] = 1 << i
rank = 0
pivots = []
for col in 0 .. w-1:
    pivot_row = 第一个 i >= rank 且 R[i] 在 col 位为 1 的行
    if 不存在: continue
    swap(R[rank], R[pivot_row]); swap(E[rank], E[pivot_row])
    for i in 0 .. w-1, i != rank:
        if bit(R[i], col) == 1:
            R[i] ^= R[rank]
            E[i] ^= E[rank]
    pivots.append(col)
    rank += 1
```

**每个新棋盘只需：**

1. 算 `s = chase(0,b).residue`。
2. 算 `y_i = parity(E[i] & s)`，即 `y = Es`，其中 `parity(t)=popcount(t)&1`。
3. 若存在 `i>=rank` 且 `y_i=1`，立即返回 `UNSOLVABLE`，`solution_count=0`。
4. 否则将所有自由变量置零，得到特解 `x0`：第 `pivots[i]` 位等于 `y_i`，其他位为零。

由 `rank` 和 `w` 得零空间维数：

\[
\boxed{d=w-rank}.
\]

如果有解，**全部有效点击方案的数量精确等于** `2^d`；如果无解则为 `0`。无需枚举就能计算这个数量。

### 4.4 计算零空间基与完整点击差分方案

对每个自由列 `f` 构造 `Mx=0` 的独立基向量：

```text
z = 1 << f
for i in 0 .. rank-1:
    if bit(R[i], f):
        z ^= (1 << pivots[i])
```

得到 `z[0..d-1]`。再**在全灭棋盘**上向下追灯，形成整个棋盘大小的位图：

```text
B[i] = chase(z[i], [0]*h).clicks
assert chase(z[i], [0]*h).residue == 0
```

对每个新谜面，从 `x0` 得到某个完整点击特解：

```text
C0, residue = chase(x0, b)
assert residue == 0
```

**最关键的优化表达式：**

\[
\boxed{C(t)=C_0\oplus\bigoplus_{i=0}^{d-1}t_i B_i,
\qquad t\in GF(2)^d.}
\]

这里 `C0`、`B[i]` 都是包含 `N=h*w` 个点击位的整数。**每种组合无需重新追灯。** 优化问题成为：

\[
\boxed{\min_{t\in GF(2)^d}\operatorname{popcount}(C(t)).}
\]

如果 `d=0`，解唯一，直接返回 `C0` 及 `OPTIMAL`。如果 `C0=0`，最优点击次数就是零，可立即结束。

## 5. 精确最优化后端（自适应选择）

### 5.1 后端 A：格雷码枚举 — 小、中等 `d` 的首选

直接枚举全部 `2^d` 个**有效解**，不枚举无效第一行。使用二进制格雷码，使相邻两次组合只改变一位：

```python
best = current = C0
best_cost = best.bit_count()
prev_gray = 0
for k in range(1, 1 << d):
    gray = k ^ (k >> 1)
    changed = (gray ^ prev_gray).bit_length() - 1
    current ^= B[changed]
    cost = current.bit_count()
    if cost < best_cost:
        best, best_cost = current, cost
    prev_gray = gray
# 已检查全部 2^d 个有效解 => OPTIMAL
```

- 时间：`O(2^d * ceil(N / word_bits))`，忽略小的循环常数。
- 额外空间：`O(ceil(N / word_bits))`，不需要存储全部组合。
- 对 Python `int` / C++ 连续 `uint64_t` 位集均适用，C++ 可用 SIMD/POPCNT。
- **默认优先试此算法。** 较复杂的分支限界未必更快。例如某些 `30×30` 实例只有 `d=20`，直接做约百万次整数异或及 `bit_count` 很有竞争力。
- 不要每步重新运行 `chase`，不要生成每个组合的二维数组，不要在枚举过程中频繁分配长度为 `N` 的对象数组。

### 5.2 后端 B：可选的 Walsh–Hadamard 变换（FWHT）

这是另一种**严格精确**的全解优化方式。它在 `N` 很大而 `d` 适中、且有足够 `2^d` 级内存时可能有优势，但不保证优于格雷码。

对于棋盘第 `p` 个点击位（`0<=p<N`），定义它在所有基中的影响签名：

\[
\sigma_p=\sum_{i=0}^{d-1}\operatorname{bit}(B_i,p)2^i.
\]

令 `a_p = bit(C0,p)`，建立长度 `2^d` 的**有符号**数组：

\[
f[v]=\sum_{p:\sigma_p=v}(-1)^{a_p}.
\]

进行原地 XOR 型 Walsh–Hadamard 变换，得到：

\[
F[t]=\sum_v f[v](-1)^{\operatorname{parity}(v\land t)}.
\]

那么 `t` 对应的点击次数**恰好**是：

\[
\boxed{\operatorname{cost}(t)=\frac{N-F[t]}2.}
\]

所以只需取 `F[t]` 最大的位置 `t*`，然后通过 `C0 XOR 对应的 B_i` 恢复最优点击位图。

FWHT 的蝶形更新：

```text
for bit in 0 .. d-1:
    span = 1 << bit
    for start in range(0, 1<<d, 2*span):
        for j in 0 .. span-1:
            a, b = F[start+j], F[start+j+span]
            F[start+j]      = a+b
            F[start+j+span] = a-b
```

- 时间 `O(N*d + d*2^d)`（生成签名时）；空间 `O(2^d)` 个有符号整数。
- 使用有符号 64 位或依据 `N` 选择足够宽的整数，**不能**对 `f` 用无符号整数或 `bytearray`。
- 需限制内存：例如 `d=24` 使用 `int64` 数据区就需要约 128 MiB，不含其他开销；`d=32` 需要约 32 GiB，通常不应选用。
- 必须检查 `(N - F[t*])` 为非负偶数，再转换为整数点击次数；用原始翻转规则再次验证答案。
- 此算法可选择性实现，不应为了使用 FWHT 而牺牲简单可靠的 Gray 后端。

### 5.3 后端 C：精确分支限界（B&B）与**分块投影动态规划下界**

当 `2^d` 过大时可尝试 B&B。它在最坏情况下仍可能访问指数级数量的节点，而且可能比 Gray 慢；关键在于下界与搜索顺序。

**搜索状态：** 深度 `k` 表示前 `k` 个零空间选择已确定，当前点击位图为 `state`；未来可用 `B[k..d-1]`。分支为“不异或 `B[k]`”与“异或 `B[k]`”。保留目前最好的完整可行解及其总点击次数 `UB`。

**快速初始上界：** 从 `C0` 做单变量翻转的局部下降，反复选择能够减少 `popcount` 的 `state XOR B[i]`；也可增加双变量交换或有固定种子的多起点搜索。它们仅用于更新已知可行上界；**局部最优不等于全局最优**。

**廉价下界 1（永远合法）：**

\[
U_k=\bigvee_{i=k}^{d-1}B_i,\qquad
LB_{\rm fixed}(k,state)=\operatorname{popcount}(state\land\neg U_k).
\]

`U[k]` 由后往前用 suffix-OR 预计算。被 `U[k]` 排除的点击位，未来任何选择都无法改变，因此它们现在的 1 必须保留。

**更强的下界 2（推荐实现）：** 将 `N` 个点击位拆成互不重叠的小块 `Q_j`（优先尝试每块 `q=8~12` 位，最后一块可不足 `q`）。每块可按整数位切片，不需要实物棋盘上相邻；初版按 row-major 连续位分块即可。

对每个深度 `k`、块 `j` 和局部状态 `s`，预计算：

\[
D_{k,j}[s]=\min_{t_k,\ldots,t_{d-1}}
\operatorname{popcount}\Bigl(s\oplus
\bigoplus_{i=k}^{d-1} t_i (B_i|_{Q_j})\Bigr).
\]

**重要：无需显式枚举全部后缀组合。** 使用下面的精确递推即可：

\[
D_{d,j}[s]=\operatorname{popcount}(s),
\]

\[
\boxed{D_{k,j}[s]=\min\left(D_{k+1,j}[s],\;D_{k+1,j}[s\oplus(B_k|_{Q_j})]\right).}
\]

对块长 `q_j`，表格 `s` 的范围是 `0..2^{q_j}-1`。实现时若本层投影 `B_k|Q_j = 0`，直接共享下一层的表格，不需要复制。

对于任意 B&B 节点，定义：

\[
\boxed{LB_{\rm blocks}(k,state)=
\sum_j D_{k,j}[state|_{Q_j}].}
\]

**这一定是合法下界：** 每个块是独立放宽优化（容许不同块选择互不一致的后缀变量），所以各块最小成本之和不可能高于真正全局最小成本。

推荐剪枝顺序：

```text
dfs(k, state):
    nodes += 1
    if popcount(state & ~suffix_or[k]) >= UB: return
    lower = 0
    for each block j:
        lower += D[k][j][extract_block(state,j)]
        if lower >= UB: return
    if k == d:
        update_incumbent_if_better(state)
        return
    a = state
    b = state XOR B[k]
    先访问当前 popcount 较少的子分支（只是启发式）
    dfs(k+1, first)
    dfs(k+1, second)
```

已知较好的 `UB` 后，若某分支下界 `>= UB`，可以放弃该分支，因为目标仅要求**任意**一个最少点击方案；若还要求字典序最小的最优方案，需要另外设计平局规则和相应剪枝。

**优化与资源限制：**

- 分块下界表的最坏数据量为 `sum_j (d+1)*2^{q_j}` 个数值；块长度不超过 255 时，局部最小点击数不超过块长，表可用 1 字节无符号值存储（`q=8..12` 适用）。
- 提前检查预计内存，超过 `max_lb_memory` 时减少块大小，或直接回退到 `LB_fixed`；不允许无上限分配表。
- 可对基向量做 `B_i <- B_i XOR B_j` (`i≠j`) 的有限次降重操作，这属于保持线性张成空间不变的可逆基变换；再按照某种可测试的顺序重新排列基向量。**必须先完成基变换与排序，再计算所有 suffix 表。**
- 基向量排序（大影响范围先搜索、小影响范围先搜索等）是启发式，只能通过基准测试决定，不应宣称普遍最优。
- 可选：再建一套不同的互不重叠分块方案，例如按列或按影响签名聚类。每套分块都给出独立的合法下界，取它们的 **`max`**；不能把有重叠区域的两个分区下界直接相加。
- 搜索深度达到末尾时必须检查候选真实 `popcount`；不能拿下界当作实际点击数。
- 如果 B&B 完整结束，返回 `OPTIMAL`；被显式时限或节点上限中断时，保留已验证的 incumbent 并返回 `FEASIBLE_UNPROVEN`。

### 5.4 后端 D：可选 CP-SAT，适合实验性的大 `d` 实例

如果项目允许依赖 `ortools`，可以直接对零空间系数 `t_i` 建模，以最大化利用已经消元后的结构。对每格新建布尔点击变量 `c_p`，满足：

\[
c_p = a_p\oplus\bigoplus_{i:\operatorname{bit}(B_i,p)=1}t_i,
\quad a_p=\operatorname{bit}(C_0,p).
\]

最小化 `sum(c_p)`。使用 OR-Tools CP-SAT 的 `add_bool_xor`，它要求给定 literal 列表的 XOR 为 **1**。正确建模：

```python
active = [t[i] for i in range(d) if ((B[i] >> p) & 1)]
if ((C0 >> p) & 1) == 1:
    model.add_bool_xor([c[p]] + active)
else:
    model.add_bool_xor([~c[p]] + active)
model.minimize(sum(c))
```

要点：

- `OPTIMAL` 才表示最优性已被证明；`FEASIBLE` 只表明找到可行解。`UNKNOWN` 不能假定已求解。
- 即使 CP-SAT 超时或模型出错，也应保留第 4 节的 `C0` 作为可靠备选解。
- 可以把内置 Gray 或局部搜索得到的更优解作为 warm start / hint，但具体 API 应以依赖版本为准。
- CP-SAT **不保证**优于 Gray、FWHT 或 B&B；以真实测试决定是否启用。
- 官方文档：<https://developers.google.com/optimization/cp/cp_solver>；布尔约束参考：<https://github.com/google/or-tools/blob/stable/ortools/sat/docs/boolean_logic.md>。

## 6. 推荐决策树（实现时允许用基准测试替换阈值）

```text
solve(board):
    校验输入，必要时转置
    G = geometry_cache.get_or_create(h,w)
    s = chase(top=0, board).residue
    y = G.E * s (mod 2)
    if y 在消元后零行位置存在 1: return UNSOLVABLE

    x0 = G.get_particular_first_row(y)
    C0 = chase(x0, board).clicks
    assert 真实点击模拟后全灭

    d = G.nullity
    if C0 == 0 or d == 0: return OPTIMAL

    取得或预处理完整零空间点击基 B[0..d-1]
    if 2^d 在计划的时间/运算预算内:
        使用 Gray（默认；最少内存）
        可选：当 FWHT 的时间/内存预计更优时采用 FWHT
    else:
        通过局部搜索获得较低的可行上界
        可选：CP-SAT（若可用，并经过该尺寸的基准测试）
        否则：B&B（优先使用分块 DP 下界）

    完成全局最优证明 => OPTIMAL
    仅因显式资源预算被迫退出 => FEASIBLE_UNPROVEN
    在任何成功返回之前，对最终 clicks 应用原始翻转规则做断言校验
    若输入前曾转置，将 clicks 转置回原方向
```

**工程默认建议，而非数学定理：** Python 使用 `d<=22` 直接 Gray 作为初始策略，`22<d<=26` 根据估算的运算量和内存选择 Gray/FWHT，`d>26` 尝试 CP-SAT 或 B&B。不同语言、CPU、棋盘尺寸及位集实现差异很大，阈值必须基准测试后确定。某些 B&B 即使能剪枝，也可能比 Gray 慢许多。

## 7. 性能优化清单（按优先级）

### P0：必须实现

1. **转置选择短边**；`w=min(H,W)`。
2. **位集表示**：行与完整点击方案均使用 packed bits；使用 XOR、AND、OR、popcount、parity。
3. **只预处理一次几何**：缓存 `M`、`RREF`、行变换矩阵 `E`、主元列、`d`、零空间基 `z`、完整点击差分基 `B`。
4. **每个谜面只追灯少量次数**：目标残留一次、特解展开一次；候选解搜索使用 `C0 XOR B_i`，不重复执行追灯。
5. **精确的无解检测与最优性状态**；绝不把“没找到”与“无解”混淆。
6. **格雷码枚举**作为稳定的低开销基准实现；必须与其他后端交叉测试。
7. **验证输出**：重新模拟十字翻转以检查全部熄灭及点击数一致。

### P1：推荐实现

8. 缓存支持同尺寸批量谜面，多次求解无需重新消元或构建零空间基。
9. B&B 使用廉价 suffix-OR 下界，以及可配置的分块 DP 投影下界；对分块表实施明确的内存上限。
10. 贪心可行上界、多起点（设置固定 seed 以复现）及基向量降重；基变换必须保持线性独立。
11. 进行 Gray/FWHT/B&B 的计时基准，以实测结果选择后端，而非固定假设 B&B 更快。

### P2：按需实现

12. CP-SAT 可选依赖与超时状态转换。
13. FWHT 对适合的 `(N,d)` 提供另一条精确路径；尤其注意 `2^d` 级内存。
14. C++/Rust 实现使用 64 位块、POPCNT、SIMD 或多线程分割搜索树；并行共享 incumbent 时保证线程安全。
15. 可以为分块 DP 设计第二套分区并取 `max`，或按影响签名聚类，但要通过基准验证收益。

## 8. 正确性依据（实现后应以这些性质写断言）

**引理 1：** 给定第一行 `p0`，第 `r` 行若要在追灯过程中被清零，则 `p_{r+1}` 必须等于递推式的结果，故后续每行点击方案唯一。

**引理 2：** 追灯残留关于第一行点击的变化是 GF(2) 线性的，故 `residue(x,b)=residue(0,b) XOR Mx`，从而可解性当且仅当 `Mx=s`。

**引理 3：** `R=EM` 且 `E` 可逆，因此 `Mx=s` 与 `Rx=Es` 等价。`R` 的零行对应的 `Es` 位必须为 0；在一致时，自由变量取零构成特解，所有自由变量独立取 0/1 构成 `2^d` 个解。

**引理 4：** 第一行追灯映射到整个点击位图是单射（完整方案的第一行就是输入），因此每个第一行解对应**恰好一个**完整有效方案，不会遗漏或重复实际点击方案。

**引理 5：** 对 `Mz=0`，在全灭棋盘上以 `z` 为第一行得到的完整位图 `B` 不会改变最终棋盘。故 `C0 XOR span(B)` **恰好**是全部有效点击方案。

**引理 6：** Gray 遍历每个 `t` 恰好一次；FWHT 由相应精确恒等式得到所有成本；B&B 的 `LB_fixed` 及 `LB_blocks` 均不超过真实后缀最优成本。所以这些后端正常完成时必然返回全局最少点击方案。

**推论：** 对固定尺寸，所有可解初始谜面恰有 `2^d` 种完整点击方案；所有 `2^N` 种棋盘中，恰有 `2^{N-d}` 种初始状态可解（占比 `2^{-d}`）。对于 `d` 大的尺寸，**均匀随机初始谜面通常不可解**，要测试大型可解实例请通过随机点击图案从全灭棋盘生成。

## 9. 必测测试集与验收准则

### 9.1 穷举对照（最重要）

对所有尺寸满足 `H*W<=12`（条件允许时扩展至 16）的棋盘，遍历**每一种初始亮灭状态**。再枚举这块棋盘的全部 `2^(H*W)` 种点击位图作为独立真值基准，对比：

- 是否有解；
- 若有解，最少点击次数完全一致；
- 有效完整点击方案数量完全一致（必须为 `2^d`）；
- 返回的方案确实使棋盘全灭。

若成本过高，至少覆盖所有小尺寸棋盘和固定随机种子的数千个实例，并包含正方形、长条形以及转置输入。

### 9.2 固定性质测试

- `1×1`：`0` 需要零次点击；`1` 需要一次点击。
- 全灭棋盘：最少点击数永远是 `0`，即使存在许多其他非零点击解。
- 非空矩形、`1×W`、`H×1`、转置后的答案还原；严格验证位序。
- 每次点击一个格子，执行两次恢复原棋盘。
- `chase(z,zero).residue==0` 对所有核基 `z` 成立。
- `M*z == 0`、`M*x0 == s`；`R == E*M`（GF(2)）。
- 不同生成方法得到的 `M`（逐个基向量追灯 vs 递推生成）逐位一致。
- B&B 与 Gray 在 `d` 小的实例上得到**相同最少点击数**；FWHT 如实现也必须一致。
- 对每个 DFS 节点的随机抽样，穷举剩余少量自由变量后验证 `LB_blocks <= 实际最优成本`。
- B&B 在强制过小节点预算下返回 `FEASIBLE_UNPROVEN`，而不是 `OPTIMAL`；解本身仍有效。
- 不存在解时返回 `UNSOLVABLE`；不应进入指数级优化步骤。

### 9.3 参考零空间维数（标准十字规则）

这些值可用于快速检查矩阵构造和 GF(2) 消元：

| 尺寸 | `d` | 可解时的点击方案总数 |
|---|---:|---:|
| `4×4` | 4 | 16 |
| `5×5` | 2 | 4 |
| `9×9` | 8 | 256 |
| `19×19` | 16 | 65,536 |
| `30×30` | 20 | 1,048,576 |
| `39×39` | 32 | 4,294,967,296 |

大型**可解**棋盘不要用均匀随机灯态构造，而应：随机生成一张点击位图，从全灭开始按该位图点击，得到起始谜面，再交给求解器求最优方案。

### 9.4 性能基准

记录不同 `(H,W,d)` 下的：预处理时间、每个谜面线性求解时间、最小化时间、搜索节点数、最大内存、最优性证明状态。将 Gray 作为基线，与 B&B（仅 suffix-OR / 加分块 DP）、FWHT、CP-SAT 比较。必须报告无解实例与可解实例的区别，避免无解快速退出扭曲性能结论。

## 10. 复杂度与现实限制

| 阶段 | 主要规模 | 说明 |
|---|---|---|
| 几何预处理、构造 `M` | `w` 次、每次 `h` 行位运算 | 形状固定时只执行一次 |
| GF(2) 消元 | 朴素位集约 `O(w^3 / machine_word_bits)` | 精确，通常远小于最优化开销 |
| 单谜面线性阶段 | 一次残留追灯、矩阵行变换、一次特解追灯 | 多项式时间 |
| Gray | `O(2^d * ceil(N / machine_word_bits))` | 近乎无额外内存；完成即精确最优 |
| FWHT | `O(N*d+d*2^d)` | 额外内存 `O(2^d)` |
| B&B | 最坏 `O(2^d)` 个分支节点 | 可能大幅剪枝，也可能更慢 |
| 分块 DP 下界预处理 | 约 `O(d * sum_j 2^{q_j})` | 内存约 `O(d * sum_j 2^{q_j})` 字节（`q<=12`） |
| CP-SAT | 无统一的多项式上界 | 必须检查求解器 status |

这里的机器字复杂度只是指导性估计；实际需考虑 Python 大整数运算、对象分配和 C++ 向量字长度等常数。最少点击优化具有与二元线性码最小汉明重量问题相同的仿射码结构；不能把 GF(2) 高斯消元的多项式时间误当作**全局最少点击优化**的多项式时间保证。

## 11. Codex 实施顺序（验收要求）

按以下顺序开发，每一阶段通过测试后才继续：

1. `validate/transpose/encode/decode`、`chase`、独立 `apply_clicks` 验证器。
2. `prepare(H,W)`：构造 `M`；缓存 `R, E, pivots, rank, z, B`。
3. `solve_linear(board)`：精确输出无解判断和一个完整可行点击方案。
4. `solve_gray(C0,B)`：完整枚举，输出最少点击方案及证明状态。
5. 全套小规模穷举测试与尺寸参考测试。**做到这里已经有正确且精确的可交付版本。**
6. 只有当实际输入规模需要时，添加 `solve_branch_bound`（带分块 DP 下界和明确内存上限）。
7. 通过基准测试后，按需添加 FWHT 与可选 CP-SAT；统一结果状态，保证后端无关性。
8. 为同形状重复使用实现预处理缓存、内存限额和压测脚本。

**最终验收条件：** 对每个输出为 `OPTIMAL` 的案例，必须有完整的最优性证明来源（唯一解、全部候选枚举、完整 B&B 搜索，或优化器正式 `OPTIMAL` 状态）。输出方案必须让所有灯熄灭，且 `click_count == sum(clicks)`。对所有拒绝求解的谜面，必须是线性方程组**确实无解**，不能仅仅因为超时。
