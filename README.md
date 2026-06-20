# MI 供应链排产沙盘

浏览器端可干预排产推演工具，主数据来自 `../draft/MI数据.xlsx`（已导出至 `data/`）。

> **新开发者 / Codex 接手**：请先读 [`../docs/Codex接手说明.md`](../docs/Codex接手说明.md)

## 两个版本

| 目录 | 说明 | 端口 |
|------|------|------|
| **`simulator/`**（本目录） | 完整需求通报（2025-12-30 起逐月更新） | 8765 |
| **`../simulator-fixed-demand/`** | 固定需求：仅 2025-12-30 首版，便于对比实际 vs 预测产量 | 8766 |

## 启动方式

因使用 ES Module 加载 JSON，需通过本地 HTTP 服务打开，不能直接双击 `index.html`。

```bash
cd simulator
python3 -m http.server 8765
```

浏览器访问：<http://127.0.0.1:8765/index.html>（或双击 `启动沙盘.command`）

## GitHub Pages 发布

如果要发布“公开页面壳 + 用户本地上传 CSV”的版本，先生成发布目录：

```bash
cd simulator
node scripts/build_github_pages.mjs
```

发布时应只使用 `simulator/dist-gh-pages/`，不要直接发布整个 `simulator/`。

`dist-gh-pages/` 只包含：

- `index.html`
- `css/`
- `js/`
- `.nojekyll`

不会包含：

- `data/`
- `sample-csv/`
- `scripts/`

因此 GitHub Pages 上公开的是前端页面壳，不包含真实数据；用户上传的 CSV 只在本地浏览器内存中解析和计算。

## 目录结构

```
simulator/
├── index.html          # 主页面
├── css/main.css
├── js/
│   ├── main.js         # 入口
│   ├── data-loader.js  # 主数据加载
│   ├── scheduler.js    # 需求通报、均衡日排产
│   ├── inventory.js    # 原料/成品库存
│   ├── procurement.js  # 按日独立采购单
│   ├── simulation.js   # 仿真引擎
│   └── ui.js           # 界面
└── data/               # 自 Excel 导出的 JSON
```

## 已实现（骨架）

- 主数据加载：6 成品、195 原料、BOM、需求通报
- 需求通报回放（非空覆盖 / NaN 沿用）；**重置时自动应用 2025-12-30 等不晚于起始日的通报**
- 均衡日排产（月剩余任务 / 剩余天数）
- 按日独立采购单（不合并），原料安全库存参与下单量
- 共线生产、原料齐套校验、缺料转产
- **步进 / 后退 1 天**（状态快照回退，支持撤销待决策的当日步进）
- **排产趋势图**：堆叠柱状图，分 SKU 色显示过往计划/实际与未来计划
- **多 SKU 可转产时暂停，人工决策弹窗**
- 成品 / 原料安全库存配置（成品 SS 默认 10，MOQ/Batch 默认 5）
- **冷启动**：重置后原料仓、成品仓均为 0；自起始日（默认 2026-01-01）起 MRP 触发 SS 补产，采购下单不早于起始日，首批 SS 组装日 ≈ 起始日 + BOM 最长采购提前期（约 30 天，即 1/31）；6 SKU 共线按原料池**联合齐套**，同日一次补满 SS 合计 60

## 重新导出主数据

```bash
python3 scripts/export_data.py
```

（或运行项目根目录下等价的 pandas 导出脚本，输出到 `simulator/data/`。）

## 需求与逻辑说明

- 早期需求：`../docs/供应链模拟器-需求与设定.md`
- **当前实现（推荐）**：`../docs/供应链模拟器-流程与逻辑说明.md`（日订单、MRP、SS 批次、PO 倒推、产能等）


## GitHub Pages 发布

先生成 GitHub Pages 用的纯静态目录：

```bash
cd simulator
node scripts/build_github_pages.mjs
```

生成结果在 `simulator/dist-gh-pages/`，其中只包含：

- `index.html`
- `css/`
- `js/`
- `.nojekyll`

不会包含：

- `data/`
- `sample-csv/`
- 其他本地脚本与调试文件

因此 GitHub Pages 公开的是页面壳，用户上传的 CSV 仍只在本地浏览器内存中处理。
