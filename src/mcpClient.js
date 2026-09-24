// 极简 MCP Streamable HTTP 客户端：只覆盖 initialize + tools/call，够用于本 bot 的下单流程。
// 与 luckin CLI 使用同一个网关 (~/.luckin/bin/.../luckin 里 strings 出的生产地址) 和同一个登录 token。

import { taskSignal } from './taskContext.js';

// 一个进程现在会同时连接瑞幸 MCP 和地图 MCP。每个 endpoint 都必须有
// 独立的会话 ID，否则第二个服务会覆盖第一个服务的 Mcp-Session-Id。
const sessions = new Map();

function endpointKey(url, token) {
  return `${url}::${token ?? ""}`;
}

async function rpc(url, token, body) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const key = endpointKey(url, token);
  const sessionId = sessions.get(key);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  // 同样不能没有超时：网关抽风时会把整条消息处理链一起挂死。
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: taskSignal(30_000) });
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) sessions.set(key, newSession);

  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text}`);

  // Streamable HTTP 可能返回纯 JSON，也可能返回 SSE（data: 前缀的多行）。
  const jsonLine = text
    .split("\n")
    .find((line) => line.startsWith("data:")) ?? text;
  const payload = jsonLine.startsWith("data:") ? jsonLine.slice(5).trim() : jsonLine;
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`MCP 返回了非 JSON 内容（可能是网关内部报错）: ${text.slice(0, 300)}`);
  }
  if (parsed.error) throw new Error(`MCP RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

export async function mcpInitialize(url, token) {
  sessions.delete(endpointKey(url, token));
  await rpc(url, token, {
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lucky-barista-feishu-bot", version: "0.1.0" },
    },
  });
}

export async function mcpListTools(url, token) {
  const result = await rpc(url, token, {
    jsonrpc: "2.0",
    id: "list",
    method: "tools/list",
    params: {},
  });
  return result.tools;
}

export async function mcpCallTool(url, token, name, args) {
  const result = await rpc(url, token, {
    jsonrpc: "2.0",
    id: `${name}-${Date.now()}`,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const text = result?.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : result;
}
