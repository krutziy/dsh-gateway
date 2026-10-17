import http from 'node:http'
import net from 'node:net'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-gateway'

// 导出 Config schema 后，dsh 插件详情页会自动生成设置表单，保存即热更新。
export const Config = z.object({
  host: z.string().default('127.0.0.1').volatile().description('监听地址（127.0.0.1 仅本机/隧道可访问；0.0.0.0 会暴露公网，务必配合令牌）'),
  port: z.number().step(1).min(1).max(65535).default(3081).volatile().description('监听端口（网关自己的端口，不能与 dsh web 相同）'),
  targetHost: z.string().default('127.0.0.1').volatile().description('转发目标地址（dsh web 监听的地址）'),
  targetPort: z.number().step(1).min(1).max(65535).default(3080).volatile().description('转发目标端口（dsh web 端口）'),
  token: z.string().role('secret').default('').volatile().description('可选访问令牌，留空不鉴权；浏览器可带 ?token=xxx'),
})

// 兼容 Volatile 包装值和普通值
function val(v) {
  return v && typeof v.get === 'function' ? v.get() : v
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const state = { startedAt: null, lastError: null }

  function start() {
    const host = val(config.host)
    const port = val(config.port)
    const targetHost = val(config.targetHost)
    const targetPort = val(config.targetPort)
    const token = val(config.token)
    state.startedAt = new Date().toISOString()

    // dsh web 可能只绑定 IPv6 (::1) 或只绑定 IPv4 (127.0.0.1)。
    // 启动后按候选顺序探测上游可达地址，选中后直接改连那个地址，
    // 避免硬编码 127.0.0.1 而上游只听 IPv6 时出现 502。
    let probed = false
    let effectiveHost = targetHost

    function candidates() {
      if (targetHost === '127.0.0.1' || targetHost === 'localhost') return ['127.0.0.1', '::1']
      if (targetHost === '::1') return ['::1', '127.0.0.1']
      return [targetHost]
    }

    function probe(host) {
      return new Promise((resolve) => {
        const s = net.connect({ port: targetPort, host })
        const done = (ok) => {
          s.destroy()
          resolve(ok)
        }
        s.once('connect', () => done(true))
        s.once('error', () => done(false))
      })
    }

    async function ensureProbed() {
      if (probed || candidates().length === 1) return
      probed = true
      for (const c of candidates()) {
        if (await probe(c)) {
          if (c !== targetHost) logger.info(`[dsh-gateway] 上游 ${targetHost} 不可达，已改连 ${c}`)
          effectiveHost = c
          return
        }
      }
      logger.warn(`[dsh-gateway] 上游 ${targetHost}:${targetPort} 所有候选地址均不可达，请确认 dsh web 正在运行`)
    }

    function authorized(req) {
      if (!token) return true
      const auth = req.headers.authorization || ''
      const q = new URL(req.url || '/', 'http://x').searchParams.get('token') || ''
      return auth === `Bearer ${token}` || q === token
    }

    function rewriteHeaders(original) {
      const headers = { ...original }
      headers.host = `${targetHost}:${targetPort}`
      delete headers.authorization
      return headers
    }

    function recordAndFail(res, err) {
      state.lastError = `${err.code || ''} ${err.message}`.trim()
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end(
        `dsh-gateway: upstream unreachable (${state.lastError}). ` +
          `Target is ${targetHost}:${targetPort}. ` +
          `Visit /__gateway__/status for diagnostics.`,
      )
    }

    async function statusHandler(req, res) {
      const reach = {}
      for (const c of candidates()) reach[c] = await probe(c)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify(
          {
            gateway: 'dsh-gateway',
            listen: { host, port },
            target: { host: targetHost, port: targetPort, effectiveHost },
            tokenEnabled: !!token,
            upstreamReachable: reach,
            lastError: state.lastError,
            startedAt: state.startedAt,
          },
          null,
          2,
        ),
      )
    }

    const server = http.createServer(async (req, res) => {
      if (!authorized(req)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('unauthorized: missing or invalid token')
      }

      const pathname = (req.url || '/').split('?')[0]
      if (req.method === 'GET' && pathname === '/__gateway__/status') {
        return void statusHandler(req, res)
      }

      await ensureProbed()

      const opts = {
        hostname: effectiveHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: rewriteHeaders(req.headers),
      }

      const upstream = http.request(opts, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      })
      upstream.on('error', (err) => recordAndFail(res, err))
      req.pipe(upstream)
    })

    server.on('upgrade', async (req, socket, head) => {
      if (!authorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return socket.destroy()
      }

      await ensureProbed()

      const opts = { port: targetPort, host: effectiveHost }

      const upstreamSocket = net.connect(opts, () => {
        let reqStr = `${req.method} ${req.url} HTTP/1.1\r\n`
        for (const [k, v] of Object.entries(rewriteHeaders(req.headers))) {
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
      upstreamSocket.on('error', (err) => {
        state.lastError = `${err.code || ''} ${err.message}`.trim()
        socket.destroy()
      })
      socket.on('error', () => upstreamSocket.destroy())
    })

    server.on('error', (err) => {
      state.lastError = `${err.code || ''} ${err.message}`.trim()
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

  // 注意：ctx.effect 的 setup 必须返回清理函数本身（不是调用结果）。
  // 若返回 stop() 的 Promise，Cordis 会在 apply 后立即处理该 Promise，
  // 导致 server.close() 在 listen 完成前被调用、绑定被静默中止。
  ctx.effect(() => stop)
}
