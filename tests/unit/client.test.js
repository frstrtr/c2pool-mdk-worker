'use strict'

const test = require('brittle')
const http = require('node:http')
const { C2poolApi, parseNodeUrl } = require('../../src/api/client')
const { PATHS } = require('../../src/constants')

async function freePort () {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function httpServer (t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.teardown(() => new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  }))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('node URLs: plain http(s) origin with an optional path prefix', t => {
  t.is(parseNodeUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  t.is(parseNodeUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
  t.is(parseNodeUrl('https://pool.example.org/c2pool/dash/'), 'https://pool.example.org/c2pool/dash')
  const bad = [
    'ftp://h', 'file:///etc/passwd', 'http://u:p@h', 'http://u@h', 'http://h/?a=1', 'http://h/?', 'http://h/#x',
    'http://h/control', 'http://h/a/Control/b', 'http://h/%2e%2e/control', 'not a url', '', 42, null
  ]
  for (const value of bad) t.exception(() => parseNodeUrl(value), /ERR_C2POOL_NODE_URL_INVALID/, String(value))
})

test('only allow-listed paths, only GET, no redirects, a timeout on every request', async t => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, init })
    return new Response('{"ok":true}', { status: 200 })
  }
  const api = new C2poolApi({ nodeUrl: 'http://127.0.0.1:8080/prefix/', fetch })
  for (const path of ['/control/stop', '/control/mining', '/pplns/miner/X', '/local_stats?x=1', '../etc', '']) {
    await t.exception(api.get(path), /ERR_C2POOL_PATH_NOT_ALLOWED/, path)
  }
  t.is(seen.length, 0, 'nothing was sent for a refused path')
  t.ok(PATHS.every(p => !p.startsWith('/control')))

  t.alike(await api.get('/local_stats'), { ok: true })
  t.is(seen[0].url, 'http://127.0.0.1:8080/prefix/local_stats')
  t.is(seen[0].init.method, 'GET')
  t.is(seen[0].init.redirect, 'manual')
  t.is(seen[0].init.headers.Accept, 'application/json')
  t.ok(seen[0].init.signal instanceof AbortSignal)
  t.absent('body' in seen[0].init)
})

test('HTTP errors, redirects, bad JSON, timeouts and refused connections map to ERR_C2POOL_*', async t => {
  const { url } = await httpServer(t, (req, res) => {
    if (req.url === '/local_stats') return res.end('{"a":1}')
    if (req.url === '/stratum_stats') {
      res.statusCode = 500
      return res.end('{"error":"boom"}')
    }
    if (req.url === '/global_stats') {
      res.writeHead(302, { Location: '/local_stats' })
      return res.end()
    }
    if (req.url === '/pplns/current') return res.end('<html>not json</html>')
    // /recent_blocks never answers
  })

  const api = new C2poolApi({ nodeUrl: url, timeoutMs: 300 })
  t.alike(await api.get('/local_stats'), { a: 1 })
  await t.exception(api.get('/stratum_stats'), /ERR_C2POOL_HTTP \/stratum_stats 500$/)
  await t.exception(api.get('/global_stats'), /ERR_C2POOL_HTTP \/global_stats 302$/, 'a redirect is not followed')
  await t.exception(api.get('/pplns/current'), /ERR_C2POOL_DATA \/pplns\/current \(invalid JSON\)$/)
  await t.exception(api.get('/recent_blocks'), /ERR_C2POOL_NODE_UNREACHABLE \/recent_blocks TIMEOUT$/)

  const closed = new C2poolApi({ nodeUrl: `http://127.0.0.1:${await freePort()}`, timeoutMs: 2000 })
  await t.exception(closed.get('/local_stats'), /ERR_C2POOL_NODE_UNREACHABLE \/local_stats ECONNREFUSED$/)

  const blocked = new C2poolApi({ nodeUrl: 'http://127.0.0.1:6667' })
  await t.exception(blocked.get('/local_stats'), /ERR_C2POOL_NODE_UNREACHABLE \/local_stats BAD_PORT$/, 'a port fetch refuses to dial')
})

test('an error message carries the path, never the host or the body', async t => {
  const { url } = await httpServer(t, (req, res) => {
    res.statusCode = 503
    res.end('{"secret":"do-not-leak"}')
  })
  const api = new C2poolApi({ nodeUrl: url })
  const err = await api.get('/local_stats').catch(e => e)
  t.is(err.message, 'ERR_C2POOL_HTTP /local_stats 503')
  t.absent(err.message.includes('127.0.0.1') || err.message.includes('do-not-leak'))
})
