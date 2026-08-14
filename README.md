# luckyday · 飞书机器人

把 `lucky-barista` 专家 Skill（五阶段饮品研发对话）搬到飞书群聊/私聊里，走完流程后通过瑞幸点单 MCP
完成预览下单。复用 `luckin` CLI 已验证可用的模型配置和 MCP 登录态，不重复造轮子。

## 架构

```
飞书用户消息 → 事件订阅 webhook (/feishu/events)
             → 按 open_id 维护多轮会话历史 (src/session.js，内存版)
             → LLM 调用（系统提示词 = ~/.luckin/skills/lucky-barista/SKILL.md）
             → 模型决定调用 MCP 工具时 → 瑞幸点单 MCP (src/mcpClient.js)
             → 回复通过飞书消息 API 发回同一个 chat
```

## 部署状态

当前跑在腾讯云轻量应用服务器（北京）上，pm2 常驻 + 开机自启，公网入口走 ngrok 固定域名
（`https://sharpie-poise-yahoo.ngrok-free.dev/feishu/events`，域名备案好之前的过渡方案）。
本机电脑关闭不影响运行。

## 文档

设计过程文档、流程图等归档在 [`docs/`](./docs)。

## 前置条件（需要你去做的部分）

1. **飞书自建应用**：[开发者后台](https://open.feishu.cn/app) 创建企业自建应用，拿到 App ID / App Secret。
2. **事件订阅**：把这个服务部署到一个公网可达地址后，在应用后台「事件与回调」里配置
   请求网址为 `https://你的域名/feishu/events`，订阅 `im.message.receive_v1` 事件。
3. **机器人权限**：开通「获取与发送单聊、群聊消息」等 IM 相关权限，并把机器人加入要用的群/单聊。
4. **本地开发时的公网入口**：没有服务器可以先用 `ngrok http 3000` 之类的内网穿透工具临时测试。

## 配置

```bash
cp .env.example .env
```

`LLM_*` 三项和 `LUCKIN_MCP_ORDER_TOKEN` 可以直接从本机已经跑通的 luckin 配置里抄：

```bash
cat ~/.luckin/.env        # 有 LUCKIN_MCP_ORDER_TOKEN 和 LUCKIN_API_KEY
cat ~/.luckin/config.json # 有 base_url / model
```

`FEISHU_*` 四项去开发者后台拿。

## 运行

```bash
npm install
npm start
```

## 安全边界（继承自 `~/.claude/plans/luckin-agent-capability.md`）

- 五阶段对话（SCENE/TASTE/FLAVOR/COFFEE_INTENSITY/BASIC_PARAMETERS）期间，系统提示词里明确禁止调用任何 MCP 工具。
- 只有走到"可下单草案"且用户确认后才 `previewOrder`；只有用户看到预览价格并明确说"确认下单"后才 `createOrder`。
- 不在日志/代码里保存明文 Token；`.env` 已在 `.gitignore` 里（见下）。
- 会话状态目前是进程内存，重启即清空，没有做用户身份和瑞幸会员的绑定校验——多用户生产化前需要补一层鉴权。

## 已知未完成项（诚实标注，不是"能跑就是完成"）

- `src/mcpClient.js` 是最小 Streamable HTTP 实现，没有处理服务端主动推送通知（notifications）、
  没有做连接失败自动重连；如果瑞幸网关行为和假设不符，需要对照 `~/.luckin/logs/mcp.log` 调整。
- 没有做飞书事件的签名/加密校验（`FEISHU_ENCRYPT_KEY`），生产环境建议按官方文档补上。
- 域名 `huangtangai.top` 尚未走完 ICP 备案，暂时用 ngrok 隧道过渡；备案通过后需切回域名 + Nginx + HTTPS 证书。
