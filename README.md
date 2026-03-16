# clawpal-connect (hosted relay connector)

`clawpal-connect` 是 ClawPal 官方 relay 模式的宿主连接器 CLI。

## 产品主流程（推荐且默认）
1. 全局安装：

```bash
npm install -g clawpal-connect
```

2. 直接运行：

```bash
clawpal-connect run
```

3. 如果本机还没有绑定，终端会立即打印 pairing code。
4. 在 ClawPal App 里输入该 pairing code 完成绑定。
5. 绑定完成后，当前 `run` 进程会继续启动 connector 运行时（不需要重新执行命令）。

## 首次运行示例

```bash
$ clawpal-connect run
No local binding found. Starting a new pairing session...
pairing code=AB12CD
action=Enter this code in ClawPal App to bind this connector.
status=Waiting for binding completion...
status=Binding completed. Continuing connector startup...
...
connector started for host=host-xxx via transport=ws
```

## 已绑定机器的行为

如果本地已经存在有效绑定：

```bash
clawpal-connect run
```

会直接按原有流程启动，不会再次进入 pairing。

## 命令

### `clawpal-connect run`

```bash
clawpal-connect run
```

常用参数：
- `--backend-url <url>`：覆盖 relay backend 地址（首次无绑定时也用于创建 pairing session）
- `--gateway <url>`：覆盖本次运行的 OpenClaw gateway 地址
- `--token <token>`：覆盖本次运行的 OpenClaw gateway token
- `--timeout-ms <ms>`：覆盖本次运行的 gateway probe timeout
- `--heartbeat-ms <ms>`：覆盖本次运行的 heartbeat interval
- `--web-ui`：打开本地诊断页面

### `clawpal-connect pair`（可选高级命令）

```bash
clawpal-connect pair
```

`pair` 会创建 pairing session、打印 code、等待 App 完成绑定，并把绑定与运行默认配置写入本地；它不会启动 connector 生命周期。

常用参数：
- `--backend-url <url>`：relay backend 地址
- `--host-name <name>`：配对时上报的宿主显示名
- `--gateway <url>`：写入本地 runtime 默认 gateway
- `--token <token>`：写入本地 runtime 默认 token
- `--timeout-ms <ms>`：写入本地 runtime 默认 timeout
- `--heartbeat-ms <ms>`：写入本地 runtime 默认 heartbeat

### `clawpal-connect status`

```bash
clawpal-connect status --gateway http://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

查看 gateway 检测状态、本地绑定状态。

## 本地持久化文件

- Host registry：`~/.clawpal-connect/host-registry.json`
- Runtime config：`~/.clawpal-connect/runtime-config.json`

首次 `run` 配对成功后，这两个文件会自动写入。

## Relay 对接契约（connector 侧）

首次无绑定时，connector 期望 relay 提供：

1. `POST /connector/pair/session`
- 用途：创建新的 pairing session，返回短码
- 期望返回字段（最小集）：`sessionId`、`code`
- 可选返回：`statusEndpoint`、`pollAfterMs`、`expiresAt`

2. `GET /connector/pair/session/:sessionId`
- 用途：轮询 session 状态
- pending 状态：`pending`/`waiting`/`created` 等
- 完成状态：`paired`/`bound`/`completed` 等，并返回绑定信息（至少 `hostId` + `userId`）
- 失败状态：`expired`/`cancelled`/`failed` 等

绑定完成 payload 中可附带 runtime 默认配置（如 `gatewayUrl`、`gatewayToken`、`heartbeatMs`、`gatewayTimeoutMs`），connector 会自动持久化。

## 开发与测试

```bash
npm install
npm run build
npm test
```
