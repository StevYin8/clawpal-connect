# 实现说明：宿主控制动作执行侧闭环（2026-04-01）

## 范围

本轮只补执行侧最小闭环：

1. 接住 relay 下发的宿主解绑控制消息
2. 接住 relay 下发的网关重启控制消息
3. 对“手动重启网关”执行真实本机命令，而不是提示用户手工处理

---

## 本轮已实现

### 1. backend client 扩展控制消息监听

新增能力：

- `onHostUnbind(handler)`
- `onGatewayRestart(handler)`

涉及文件：

- `src/backend_client.ts`
- `src/mock_backend_transport.ts`
- `src/ws_backend_transport.ts`

### 2. ws transport 识别 relay 控制消息

当前可识别：

- `relay.host_unbind`
- `relay.host.unbind`
- `relay.control + host_unbind`
- `relay.gateway_restart`
- `relay.gateway.restart`
- `relay.control + gateway_restart`

目的：兼容现有 relay 控制封装，不把协议格式卡死在单一路径上。

### 3. connector runtime 落真实重启执行

- `src/connector_runtime.ts`
  - 收到 `GatewayRestartControl` 后调用本机命令执行器
  - 真正执行：`openclaw gateway restart`
  - 打印成功/失败日志
  - 不再回 placeholder 提示文案

默认命令执行器：

- `OpenClawGatewayCommandRunner`

---

## 实际代码位置

- `src/backend_client.ts`
- `src/ws_backend_transport.ts`
- `src/mock_backend_transport.ts`
- `src/connector_runtime.ts`
- `dist/*` 对应产物同步更新

---

## 行为语义

### host unbind

- 若收到的 `hostId` 与当前活跃宿主一致：
  - 本地 registry 执行 unbind
  - 打日志
  - 停止 runtime

### gateway restart

- 若收到的 `hostId` 与当前活跃宿主一致：
  - 调用 `openclaw gateway restart`
  - 记录命令、exitCode、signal、stdout、stderr 摘要
  - 成功打印 success log
  - 失败打印 error log

---

## 测试回填

### 已新增 / 已通过

- `tests/ws_backend_transport.test.ts`
  - 覆盖 host unbind control 分发
  - 覆盖 gateway restart control 分发

- `tests/connector_runtime.test.ts`
  - 验证 runtime 侧能消费控制消息并走命令执行路径

### 本地验证结果

- `npm run build` ✅
- `npm test -- --run tests/connector_runtime.test.ts tests/ws_backend_transport.test.ts` ✅

---

## 已知限制

1. 当前仅记录本机执行日志，未把 restart 执行结果主动回传 relay
2. 只处理当前活跃 host 的控制消息，不做跨 host 排队
3. `dist/` 产物已同步更新；后续若调整协议，需要保持 `src/` 与 `dist/` 一起更新
