# dsh-gateway：纯转发网关插件

把一个额外端口反向代理到 dsh web，支持 HTTP 与 WebSocket，零第三方依赖、零构建（纯 JS，git 安装无需任何构建授权）。

## 安装

```sh
# 前置：服务器上要有 pnpm（dsh plugin 内部调用它）
npm install -g pnpm

# 安装到 web profile
dsh plugin --profile web add github:krutziy/dsh-gateway

# 或在 dsh Web UI 的插件市场里填 Git 仓库地址安装：
# https://github.com/krutziy/dsh-gateway
```

启动日志出现 `[dsh-gateway] http://127.0.0.1:3081 -> http://127.0.0.1:3080` 即成功。

## 配置

在 dsh Web UI 的插件页面找到 dsh-gateway，直接编辑表单字段，**保存即热更新**（无需重启 dsh）：

| 字段 | 默认 | 说明 |
|---|---|---|
| 监听地址 | `127.0.0.1` | 仅本机回环，隧道场景安全；改 `0.0.0.0` 会暴露公网，务必配合令牌 |
| 监听端口 | `3081` | 网关自己的端口，**不能和 dsh web（3080）相同** |
| 转发目标地址 | `127.0.0.1` | 上游地址 |
| 转发目标端口 | `3080` | dsh web 的端口 |
| 令牌 | 空 | 可选 Bearer token；为空不鉴权。浏览器访问不便带 header 时可用 `?token=xxx` |

## 隧道用法

```sh
# 本地执行，把服务器 3081 映射到本地 3081
ssh -N -L 3081:127.0.0.1:3081 user@server
# 然后浏览器打开 http://127.0.0.1:3081
```

## 排查 502

502 只会在「网关活着、但连不上 dsh web」时出现。浏览器打开：

```
http://127.0.0.1:3081/__gateway__/status
```

返回 JSON：监听/目标配置、上游各候选地址（127.0.0.1 与 ::1）实时可达性、最近一次错误。

v0.2.0 起，网关会自动探测 dsh web 绑定的是 IPv4 还是 IPv6 并改连可达地址（`上游 127.0.0.1 不可达，已改连 ::1`），双栈问题已自动处理。若 status 显示两个地址都不可达，说明 dsh web 没在目标端口运行——检查「转发目标端口」配置是否与实际一致。

## 安装问题排查

- `dsh plugin add github:krutziy/dsh-gateway` 报 prepare/allowBuilds 相关错误：本包是纯 JS、无构建脚本，此报错通常是 GitHub 拉取超时，**直接重试**即可
- 装完后 3081 没监听：插件代码随 dsh 进程加载，**必须完整重启 dsh web**（remove/add 后不重启不生效）
- 验证三板斧：`ss -tlnp | grep 3081` → `curl 127.0.0.1:3081/__gateway__/status` → 看启动日志有没有 `[dsh-gateway]` 行

## 说明

- 纯转发：不做改写、不限流，出问题时直接连 dsh web 端口排查
- 隧道直连 dsh web 端口本来就能用；这个插件的意义是统一入口 + 可视化配置 + 可选令牌
- 移除：`dsh plugin --profile web remove dsh-gateway`
