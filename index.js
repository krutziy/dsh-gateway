import http from 'node:http'
import net from 'node:net'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-gateway'

// 导出 Config schema 后，dsh 插件页面会自动生成设置表单，保存即热更新。
export const Config = z.object({
  host: z.string().default('127.0.0.1').volatile().description('监听地址（127.0.0.1 仅本机/隧道可访问）'),
  port: z.number().step(1).min(1).max(65535).default(3081).volatile().description('监听端口（不能和 dsh web 相同）'),
  targetHost: z.string().default('127.0.0.1').volatile().description('转发目标地址'),
  targetPort: z.number().step(1).min(1).max(65535).default(3080).volatile().description('转发目标端口（dsh web 端口）'),
  token: z.string().role('secret').default('').volatile().description('可选访问令牌，留空不鉴权'),
})

export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  function start() {
    const host = config.host.get()
    const port = config.port.get()
    const targetHost = config.targetHost.get()
    const targetPort = config.targetPort.get()
    const token = config.token.get()

    function authorized(req) {
      if (!token) return true
      const auth = req.headers.authorization || ''
      const q = new URL(req.url || '/', 'http://x').searchParams.get('token') || ''
      return auth === `Bearer ${token}` || q === token
    }

    const server = http.createServer((req, res) => {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('unauthorized: missing or invalid token')
      }
      const headers = { ...req.headers }
      headers.host = `${targetHost}:${targetPort}`
      delete headers.authorization

      const upstream = http.request(
        { hostname: targetHost, port: targetPort, method: req.method, path: req.url, headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        },
      )
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`gateway upstream error: ${err.message}`)
      })
      req.pipe(upstream)
    })

    server.on('upgrade', (req, socket, head) => {
      if (!authorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const upstreamSocket = net.connect(targetPort, targetHost, () => {
        const headers = { ...req.headers }
        headers.host = `${targetHost}:${targetPort}`
        delete headers.authorization

        let reqStr = `${req.method} ${req.url} HTTP/1.1\r\n`
        for (const [k, v] of Object.entries(headers)) {
          if (v === undefined) continue
          if (Array.isArray(v)) for (const vv of v) reqStr += `${k}: ${vv}\r\n`
          else reqStr += `${k}: ${v}\r\n`
        }
        reqStr += '\r\n'

        upstreamSocket.write(reqStr)
        if (head && head.length) upstreamSocket.write(head)
        socket.pipe(upstreamSocket)
        upstreamSocket.pipe(socket)
      })
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
    })

    server.on('error', (err) => {
      logger.error(`[dsh-gateway] listen failed: ${err.message}`)
    })

    server.listen(port, host, () => {
      logger.info(`[dsh-gateway] http://${host}:${port} -> http://${targetHost}:${targetPort}${token ? ' (token on)' : ''}`)
    })

    return () => new Promise((resolve) => server.close(() => resolve()))
  }

  let stop = start()

  // 插件页面保存配置后热更新：重启监听
  ctx.on('loader/volatile-update', () => {
    void (async () => {
      await stop()
      stop = start()
    })()
  })

  ctx.effect(() => stop())
}
