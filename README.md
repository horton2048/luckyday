# Lucky Day · 当前实现与迭代入口

更新于 2026-09-24。本目录是用户指定的当前产品版本，也是后续 HTML 演示的功能依据。旧版“五阶段饮品研发机器人”的说明已归档，不再代表现状。

Lucky Day 是驻留在 IM 中的 Agent 原生商家店铺：通过对话和可操作卡片提供饮品服务，保留口味和服务历史，承接下一次需求。企业工作群是当前使用场景。

## 当前能力与代码入口

| 能力 | 主要实现 |
| --- | --- |
| 对话意图分流、普通聊天和设置 | `src/router.js`、`src/server.js` |
| 门店搜索、地点理解、默认门店与上下文 | `src/maps.js`、`src/storeResolver.js`、`src/storeContext.js`、`src/preferences.js` |
| 商品选择、规格、数量、报价、确认与支付卡 | `src/orderUi.js`、`src/orderSnapshot.js`、`src/cards.js` |
| 商品缩略图 | `src/productImages.js` |
| 专属推荐与到岗位置场景 | `src/recommend.js`、`src/recoCards.js`、`src/arrivals.js` |
| 团队拼单、成员选择与统一确认 | `src/party.js`、`src/partyCards.js`、`src/afternoonTea.js` |
| 口味记忆与历史订单 | `src/tasteProfiles.js`、`src/tastes.js` |
| 许愿、聚合、投票和状态反馈 | `src/wishes.js`、`src/wishCards.js`、`prompts/wish.md` |
| 预约与到点处理 | `src/scheduler.js` |
| 飞书事件与卡片交互、模型及商品服务 | `src/server.js`、`src/feishu.js`、`src/llm.js`、`src/mcpClient.js` |

## 判断功能现状

先读 [云端开发交接](docs/云端开发交接.md)，再看 `src/` 和 `tests/`。本地工作区另有 [线上部署档案](../LuckyDay-线上部署档案.md) 与 [验收记录](reports/)，其中可能包含运行信息，未整体上传到公开仓库。

- 9 月 16 日：卡片与真实按钮修复记录。
- 9 月 18 日：支付展示与意图分流修复记录。
- 9 月 22 日：门店语义锁定修复，见部署档案。
- 9 月 24 日：饮品缩略图发布记录；未发送卡片实体的验收不等同于客户端人工视觉验收。

以上是已有记录索引，不代表本次整理重新进行了线上验收。

## 演示需要保留的边界

- 菜单中有合适商品时走点单；没有时记录愿望，不承诺任意配方可制作或新品必定上市。
- 预约按当前代码处理：预约时确认金额，到点重新核价；同价时创建待支付单，价格或可售情况变化时要求重新确认。
- 创建待支付订单、展示支付入口和实际支付完成是不同状态。
- 自动触发和周期服务受配置、权限与运行状态约束，不仅凭代码存在就宣称全员可用。
- 普通工作群消息自动推断所有需求、预算管理等能力，不能因演示剧情需要就写成已实现功能。

## 迭代资料

本地工作区保留规格与验收报告，便于理解迭代过程。规格中的旧状态和设想需与后续实现核对。

展示成果位于本地工作区的 `12强赛战队物料提交/`；早期 UI、旧演示脚本和 8 月方案草稿已移至本地 `历史归档/`，不再作为现行设计依据。

## 本地运行

依赖与启动入口以 `package.json` 为准。已有 `.env` 时沿用现有配置；新环境根据 `.env.example` 配置飞书、模型、点单服务及可选地图服务。

```bash
npm install
npm start
```

服务入口为 `src/server.js`，飞书事件接收路径为 `/feishu/events`。线上运行目录为 `/opt/lucky-barista`，开发目录为 `/opt/luckyday-dev`；发布步骤见交接文档。
