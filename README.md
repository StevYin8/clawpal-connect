# clawpal-connect (hosted relay connector)

`clawpal-connect` 是 ClawPal 官方 relay 模式的宿主连接器 CLI。

## 产品主流程（推荐且默认）
1. 全局安装：

```bash
npm install -g clawpal-connect
```

2. 首次绑定：

```bash
clawpal pair
```

3. 终端会显示一个 **6 位 pairing code**。
4. 在 ClawPal App 里输入该 pairing code 完成绑定。
5. 绑定完成后，当前 `pair` 进程会自动继续启动 connector 运行时（不需要重新执行命令）。

## 首次绑定示例

```bash
$ clawpal pair
Starting a new pairing session...
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
clawpal run
```

会直接按原有流程启动，不会再次进入 pairing。

## 命令

### `clawpal pair`

```bash
clawpal pair
```

作用：
- 创建 pairing session
- 打印 code
- 等待 App 完成绑定
- 写入本地绑定和运行配置
- **绑定成功后自动继续执行 `clawpal run` 的运行流程**

常用参数：
- `--backend-url <url>`：relay backend 地址（默认使用发行版内置值，或由 `CLAWPAL_BACKEND_URL` 提供）
- `--host-name <name>`：配对时上报的宿主显示名
- `--gateway <url>`：覆盖本地 OpenClaw gateway 地址
- `--token <token>`：覆盖本地 OpenClaw gateway token
- `--timeout-ms <ms>`：覆盖 probe timeout
- `--heartbeat-ms <ms>`：覆盖 heartbeat interval

### `clawpal run`

```bash
clawpal run
```

作用：
- 使用本地已保存的绑定配置，直接启动 connector

如果还没有绑定，会明确提示你先执行：

```bash
clawpal pair
```

常用参数：
- `--backend-url <url>`：覆盖 relay backend 地址
- `--gateway <url>`：覆盖本次运行的 OpenClaw gateway 地址
- `--token <token>`：覆盖本次运行的 OpenClaw gateway token
- `--timeout-ms <ms>`：覆盖本次运行的 gateway probe timeout
- `--heartbeat-ms <ms>`：覆盖本次运行的 heartbeat interval
- `--web-ui`：打开本地诊断页面

### `clawpal status`

```bash
clawpal status
```

查看 gateway 检测状态、本地绑定状态。

## 本地持久化文件

- Host registry：`~/.clawpal-connect/host-registry.json`
- Runtime config：`~/.clawpal-connect/runtime-config.json`

首次 `pair` 成功后，这两个文件会自动写入。

## 当前默认行为

### backend
默认 backend 地址不在 README 中公开写死。

推荐做法：
- 通过发行版内置默认值使用
- 或显式传入：`--backend-url <url>`
- 或通过环境变量提供：`CLAWPAL_BACKEND_URL`

### 本地 OpenClaw gateway
如果你没有显式传 `--gateway/--token`，connector 会自动尝试读取：

- `~/.openclaw/openclaw.json`
  - `gateway.port`
  - `gateway.auth.token`

所以大多数情况下，用户不需要手填 gateway token。

## 安全说明

README 不再公开写死生产 relay 的公网 IP / 端口。
如果需要覆盖默认 backend，请优先通过：
- `--backend-url <url>`
- `CLAWPAL_BACKEND_URL`
进行注入，而不是把生产地址长期写进公开文档。

## 发布到 npm

发布前自检：

```bash
npm run release:check
```

登录 npm：

```bash
npm login
npm whoami
```

正式发布：

```bash
npm publish
```

发布后用户安装：

```bash
npm install -g clawpal-connect
clawpal --help
clawpal pair
```

## 开发与测试

```bash
npm install
npm run build
npm test
```
