# AI Chat MCP（@liuxinye/dsh-ai-chat-mcp）

把 DeepSeek Harness 本身开放成一个 **MCP 服务端**：外部工具（Claude Desktop、Cursor、n8n、任意脚本）通过 MCP 即可调用 DSH 的「创建会话、执行对话、读取记录、搜索会话、取消运行、选择模型」等常用能力。会话与本机 DSH Web UI 共享——外部创建的会话会出现在会话列表里，可以继续对话。

An MCP server hosted by DeepSeek Harness itself: external tools create sessions, run conversation turns and read answers through standard MCP. Sessions are shared with the local DSH UI.

## 安装

在 DSH 的 **设置 → 插件 → 安装** 里填包名：

```text
@liuxinye/dsh-ai-chat-mcp
```

命令行等价：

```bash
dsh plugin --profile desktop add @liuxinye/dsh-ai-chat-mcp
```

### 从源码链接（开发调试）

```bash
dsh plugin --profile desktop add "link:/绝对路径/dsh-ai-chat-mcp"
```

## 接入方式

插件启动后在本机监听（默认 `127.0.0.1:8391`）：

| 传输 | 地址 | 适用客户端 |
|---|---|---|
| Streamable HTTP（推荐） | `http://127.0.0.1:8391/mcp` | Claude Desktop / Cursor / Windsurf / Cherry Studio / n8n / 任意 MCP 客户端 |
| 旧版 HTTP+SSE | `http://127.0.0.1:8391/sse` | 仅支持 2024-11-05 SSE 传输的旧客户端 |
| stdio 桥接 | `node <插件目录>/lib/stdio-bridge.mjs --endpoint http://127.0.0.1:8391/mcp` | 仅支持 stdio 的客户端（Claude Desktop 自定义连接器、Claude Code 等） |

### 客户端配置示例

HTTP（如 Cursor / Cherry Studio 的 MCP 配置）：

```json
{
  "mcpServers": {
    "dsh": {
      "url": "http://127.0.0.1:8391/mcp"
    }
  }
}
```

stdio 桥接（如 Claude Desktop `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": [
        "<包安装目录>/lib/stdio-bridge.mjs",
        "--endpoint", "http://127.0.0.1:8391/mcp"
      ]
    }
  }
}
```

配置了 `authToken` 时，HTTP 客户端带 `Authorization: Bearer <token>`；stdio 桥接加 `--token <token>`。

## 工具一览

| 工具 | 功能 |
|---|---|
| `dsh_chat` | 一站式对话：发一条消息、等待回答；不给 `sessionId` 时自动创建会话 |
| `dsh_session_create` | 创建会话（可设工作目录、标题、agent 预设、模型） |
| `dsh_session_prompt` | 向既有会话发消息并等待本轮结束（多轮对话） |
| `dsh_session_list` | 会话列表（标题、时间、运行状态、工作目录）；默认隐藏已归档，`includeArchived` 可带出并标记 |
| `dsh_session_read` | 读取会话记录（用户消息 / 助手回答 / 回合边界 / 工具活动） |
| `dsh_session_search` | 全文搜索会话历史 |
| `dsh_session_cancel` | 取消会话正在运行的回合（保留排队消息） |
| `dsh_session_rename` | 重命名会话 |
| `dsh_session_fork` | 从某事件分叉出新会话 |
| `dsh_session_archive` | 归档会话（移出 DSH 界面会话列表，可选停止其运行中的工作） |
| `dsh_session_unarchive` | 取消归档，恢复到会话列表 |
| `dsh_model_catalog` | 列出可选模型与当前默认模型 |

> 会话**删除**未在 Host API 中开放（与 ACP 自动化面一致）；归档是受支持的"从列表移除"操作，归档后仍可 `dsh_session_read` 读取、`dsh_session_unarchive` 恢复。归档结果里的 `archivedSessionIds` 是**整个归档集合**（Host 契约如此），不是本次归档效果；本次目标在 `requestedSessionId`。`dsh_session_list` 每行带 `archived` 标记。

对话类工具在回合结束时返回：`answer`（助手文本）、`status`（`completed / error / aborted / interrupted / blocked / max-tokens / timeout`）、`usage`（token 用量）、`tools`（本轮使用的工具）与 `turn`。回合的完成以会话日志的 `turn/end` 事件为准；若客户端中断请求，会同时取消该回合。

## MCP Resources

会话同时以 MCP 资源形式暴露（`resources/list` / `resources/read` / `resources/templates/list`）：

- 资源 URI：`dsh://session/<sessionId>`，内容为该会话完整记录的 JSON
- 模板：`dsh://session/{sessionId}`

外部工具既可以调用工具（`dsh_session_read`），也可以把会话当作资源订阅/读取。

## 长任务进度

`dsh_chat` / `dsh_session_prompt` 会在客户端提供 `_meta.progressToken` 时推送 `notifications/progress` 进度里程碑：提示已受理、Agent 开始第 N 回合、执行的每个工具（`tool bash` 等）、收到助手输出。带 `progressToken` 的请求从第一个字节起就用 SSE 流响应，早期里程碑不会因快速响应而丢失；没有里程碑时每 15 秒发送一次 `working…` 心跳，同时 SSE 保活注释维持连接。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: ai-chat-mcp
      name: '@liuxinye/dsh-ai-chat-mcp'
      config:
        host: 127.0.0.1      # 监听地址；非回环地址必须配置 authToken
        port: 8391           # 监听端口
        authToken: ''        # 可选 Bearer Token；留空表示不校验
        defaultTimeoutMs: 600000   # 单轮对话默认等待上限（毫秒）
        maxBodyBytes: 1048576      # 单请求体上限（字节）
        enableLegacySse: true      # 是否提供旧版 /sse 传输
        keepAliveMs: 15000         # SSE 保活间隔（毫秒）
        jsonGraceMs: 3000          # 快速响应直接返回 JSON 的宽限窗口（毫秒）
```

## 安全

- 默认只绑定 `127.0.0.1`；配置为非回环地址且未设置 `authToken` 时插件拒绝启动（想对局域网开放，先设 Token）。
- `authToken: 'auto'`：每次启动生成随机 Token 并打在启动日志里（重启会变，客户端需同步更新）；固定 Token 用字符串值。
- 设置 Token 后所有请求必须携带 `Authorization: Bearer <token>`（常量时间比较）。
- 校验 `Origin` 头以防 DNS rebinding；仅放行回环来源。
- 每次 `tools/call` 都会写审计日志（工具名、耗时、成功/失败），可在 Host 日志中回看外部工具的操作。
- 本端点等价于「在你的 DSH 上代你对话」：把端口暴露给局域网前请务必设置 Token。

### 局域网部署示例

```yaml
- insert:
    - id: ai-chat-mcp
      name: '@liuxinye/dsh-ai-chat-mcp'
      config:
        host: 0.0.0.0        # 或本机局域网 IP
        port: 8391
        authToken: 'auto'    # 或固定字符串
```

客户端地址用 `http://<你的局域网IP>:8391/mcp`，并携带启动日志中的 Token。

## 说明与限制

- 对话执行走的是 DSH 会话服务（与 Web UI 相同的路径），会话会出现在 DSH 会话列表中。
- 单轮等待默认 10 分钟上限，超时返回已产出的部分回答并标记 `timedOut: true`，不中断 Agent 运行；需要中断时调用 `dsh_session_cancel`。
- 进度推送依赖客户端给出 `_meta.progressToken`；未提供时长任务通过 SSE 保活注释维持连接，结果仍会完整返回。
- 模型、工具、技能的可用性由用户 DSH 配置决定；本插件不改变 Agent 的能力组合。
