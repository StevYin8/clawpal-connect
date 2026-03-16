# clawpal-connect (hosted relay connector, MVP v0.3.0)

`clawpal-connect` 是 **ClawPal 官方转发模式** 的宿主端连接器。

目标体验：
- 在电脑上安装 connector
- 用 App 里的短码完成配对
- 一条命令启动 connector，常驻连接官方 relay

当前版本已经提供两条面向用户的主命令：
- `clawpal-connect pair`
- `clawpal-connect run`

---

## 当前能力边界（先说清楚）

### 已支持
- 通过短码与 relay 完成 connector 配对解析
- 把宿主端绑定信息保存到本地
- 把运行默认配置（gateway / token / timeout / heartbeat）保存到本地
- 通过 `clawpal-connect run` 启动 connector 生命周期
- 连接官方 relay、发送 host status、接收后端转发请求

### 暂未产品化完成
- 一键注册 launchd / systemd 常驻服务
- 开机自启动
- npm 官方公开发布（当前更适合源码安装或本地全局安装）
- 完整 GUI 扫码体验（当前主路径是短码配对）

所以，**当前最推荐的真实用法**是：
1. 安装
2. `pair`
3. `run`

---

## 安装

### 运行要求
- Node.js 20+
- npm 10+

### 方式 A：从源码目录安装（当前推荐）
如果你已经拿到了本仓库源码：

```bash
cd clawpal-connect
npm install
npm run build
npm install -g .
```

安装完成后，系统里就会有：

```bash
clawpal-connect
```

### 方式 B：开发阶段直接在仓库里运行
如果你只是本地开发验证，也可以直接：

```bash
cd clawpal-connect
npm install
npm run build
node dist/cli.js --help
```

---

## 现在怎么用（最短路径）

### 第一步：在 App 里拿到短码
在 ClawPal App 里生成一个配对短码。

### 第二步：在电脑上完成配对
你可以直接传短码：

```bash
clawpal-connect pair --code ABC123 --backend-url http://120.55.96.42:3001
```

或者不传 `--code`，让 CLI 交互输入：

```bash
clawpal-connect pair --backend-url http://120.55.96.42:3001
```

配对成功后，connector 会把两类配置写到本地：

- 宿主端绑定信息：`~/.clawpal-connect/host-registry.json`
- 运行默认配置：`~/.clawpal-connect/runtime-config.json`

### 第三步：直接运行 connector

```bash
clawpal-connect run
```

如果你要临时覆盖本地 OpenClaw Gateway 地址或 token，也可以：

```bash
clawpal-connect run \
  --gateway http://127.0.0.1:18789 \
  --token "$OPENCLAW_GATEWAY_TOKEN"
```

---

## 核心命令

### `clawpal-connect pair`
使用 App 里的短码完成配对，并保存本地配置。

```bash
clawpal-connect pair [--code ABC123] [--backend-url http://120.55.96.42:3001]
```

常用参数：
- `--code <code>`：App 里显示的 6 位短码
- `--backend-url <url>`：官方 relay / backend 地址
- `--host-name <name>`：为当前宿主端指定展示名称
- `--gateway <url>`：覆盖本地 OpenClaw Gateway 地址
- `--token <token>`：覆盖本地 OpenClaw Gateway token
- `--timeout-ms <ms>`：覆盖 probe timeout
- `--heartbeat-ms <ms>`：覆盖 heartbeat interval

### `clawpal-connect run`
使用本地已保存的配对配置，直接运行 connector。

```bash
clawpal-connect run
```

常用参数：
- `--backend-url <url>`：临时覆盖 relay 地址
- `--gateway <url>`：临时覆盖 OpenClaw Gateway 地址
- `--token <token>`：临时覆盖 OpenClaw Gateway token
- `--timeout-ms <ms>`：临时覆盖 gateway probe timeout
- `--heartbeat-ms <ms>`：临时覆盖 heartbeat interval
- `--web-ui`：打开本地诊断页面

### `clawpal-connect status`
查看当前 gateway / host binding / backend 配置状态。

```bash
clawpal-connect status --gateway http://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

---

## 当前推荐操作范式

### 面向真实使用

```bash
npm install
npm run build
npm install -g .
clawpal-connect pair --backend-url http://120.55.96.42:3001
clawpal-connect run
```

### 面向开发验证

```bash
npm install
npm run build
node dist/cli.js pair --code ABC123 --backend-url http://120.55.96.42:3001
node dist/cli.js run
```

---

## 本地文件

### 宿主端绑定信息
`~/.clawpal-connect/host-registry.json`

保存内容包括：
- hostId
- hostName
- userId
- backendUrl
- connectorToken / bindingCode（如果有）

### 运行默认配置
`~/.clawpal-connect/runtime-config.json`

保存内容包括：
- gatewayUrl
- gatewayToken
- gatewayTimeoutMs
- heartbeatMs

---

## 诊断与排错

### 1. 配对时报 404 / pair resolve not found
说明 relay / backend 版本过旧，未部署：
- `POST /connector/pair/resolve`

### 2. `run` 启动时报没有 paired host
说明你还没成功执行：

```bash
clawpal-connect pair
```

### 3. `run` 后 host 没上线
优先检查：
- 本地 OpenClaw Gateway 是否已启动
- `--gateway` 地址是否正确
- `--token` 是否正确
- relay 地址是否正确

### 4. 消息转发超时
说明通常是：
- connector 已连上 relay
- 但本地 gateway / runtime worker 没把结果及时回传

---

## 兼容旧命令
以下命令仍然保留，但定位为**高级 / 调试命令**：
- `bind`
- `start`
- `demo`

日常推荐优先使用：
- `pair`
- `run`

---

## 测试

```bash
npm run build
npm test
```
