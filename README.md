# clawpal-connect (hosted relay connector)

`clawpal-connect` 是 ClawPal 官方 relay 模式的宿主连接器 CLI。

## 产品主流程（推荐且默认）
1. 全局安装：

```bash
npm install -g git+https://github.com/StevYin8/clawpal-connect.git#main
```

2. 首次绑定：

```bash
clawpal-connect pair
```

3. 终端会显示一个 **6 位 pairing code**。
4. 在 ClawPal App 里输入该 pairing code 完成绑定。
5. 绑定完成后，当前 `pair` 进程会自动继续启动 connector 运行时（不需要重新执行命令）。

## 首次绑定示例

```bash
$ clawpal-connect pair
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
clawpal-connect run
```

会直接按原有流程启动，不会再次进入 pairing。

## 命令

### `clawpal-connect pair`

```bash
clawpal-connect pair
```

作用：
- 创建 pairing session
- 打印 code
- 等待 App 完成绑定
- 写入本地绑定和运行配置
- **绑定成功后自动继续执行 `clawpal-connect run` 的运行流程**

常用参数：
- `--backend-url <url>`：relay backend 地址（默认 `http://120.55.96.42:3001`）
- `--host-name <name>`：配对时上报的宿主显示名
- `--gateway <url>`：覆盖本地 OpenClaw gateway 地址
- `--token <token>`：覆盖本地 OpenClaw gateway token
- `--timeout-ms <ms>`：覆盖 probe timeout
- `--heartbeat-ms <ms>`：覆盖 heartbeat interval

### `clawpal-connect run`

```bash
clawpal-connect run
```

作用：
- 使用本地已保存的绑定配置，直接启动 connector

如果还没有绑定，会明确提示你先执行：

```bash
clawpal-connect pair
```

常用参数：
- `--backend-url <url>`：覆盖 relay backend 地址
- `--gateway <url>`：覆盖本次运行的 OpenClaw gateway 地址
- `--token <token>`：覆盖本次运行的 OpenClaw gateway token
- `--timeout-ms <ms>`：覆盖本次运行的 gateway probe timeout
- `--heartbeat-ms <ms>`：覆盖本次运行的 heartbeat interval
- `--web-ui`：打开本地诊断页面

### `clawpal-connect status`

```bash
clawpal-connect status
```

查看 gateway 检测状态、本地绑定状态。

## 本地持久化文件

- Host registry：`~/.clawpal-connect/host-registry.json`
- Runtime config：`~/.clawpal-connect/runtime-config.json`

首次 `pair` 成功后，这两个文件会自动写入。

## 当前默认行为

### backend
默认使用：

```text
http://120.55.96.42:3001
```

### 本地 OpenClaw gateway
如果你没有显式传 `--gateway/--token`，connector 会自动尝试读取：

- `~/.openclaw/openclaw.json`
  - `gateway.port`
  - `gateway.auth.token`

所以大多数情况下，用户不需要手填 gateway token。

## 开发与测试

```bash
npm install
npm run build
npm test
```
