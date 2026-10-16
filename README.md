# dsh-gateway：纯转发插件（带设置页面）

把一个额外端口反向代理到 dsh web，支持 HTTP 与 WebSocket，零第三方依赖。

**配置直接在 dsh 插件页面填写**（基于插件 Config schema 自动生成的表单，保存即热更新，无需改环境变量、无需重启）：

| 字段 | 默认 | 说明 |
|---|---|---|
| 监听地址 | `127.0.0.1` | 仅本机回环，隧道场景安全；改 `0.0.0.0` 会暴露公网，务必配合令牌 |
| 监听端口 | `3081` | 网关自己的端口，**不能和 dsh web（3080）相同**，否则端口冲突 |
| 转发目标地址 | `127.0.0.1` | 上游地址 |
| 转发目标端口 | `3080` | dsh web 的端口 |
| 令牌 | 空 | 可选 Bearer token；为空不鉴权。浏览器访问不便带 header 时可用 `?token=xxx` |

## 隧道用法

```sh
# 本地执行，把服务器 3081 映射到本地 3081
ssh -N -L 3081:127.0.0.1:3081 user@server
# 然后浏览器打开 http://127.0.0.1:3081
```

## 加载

```yaml
# cordis.yml —— 路径改为服务器上的绝对路径
- insert:
    - id: dsh-gateway
      name: '/srv/dsh-plugins/dsh-gateway/src/index.ts'
```

```sh
dsh web --patch /srv/dsh-plugins/dsh-gateway/cordis.yml
```

启动日志出现 `[dsh-gateway] http://127.0.0.1:3081 -> http://127.0.0.1:3080` 即成功。之后在 Web UI 的插件页面找到 dsh-gateway，直接编辑端口 / 令牌等字段保存即可。

## 说明

- 纯转发：不做改写、不限流，出问题时直接连 dsh web 端口排查
- 隧道直连 dsh web 端口本来就能用；这个插件的意义是统一入口 + 可视化配置 + 可选令牌，不想要时删掉 patch 即可
