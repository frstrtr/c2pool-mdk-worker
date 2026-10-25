'use strict'

const fastify = require('fastify')
const { parseArgs } = require('node:util')
const { createState, COINS } = require('./state')
const routes = require('./routes')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8080

/**
 * A stand-in for a c2pool node's web API, serving the recorded responses in
 * mock/fixtures/<coin>/. Plain HTTP; it knows nothing about MDK.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]      0 picks a free port
 * @param {'btc'|'ltc'|'dash'} [options.coin]
 * @param {object} [options.scenario]  see mock/state.js
 * @returns {Promise<{ app, state, requests, nodeUrl, setScenario, close }>}
 */
async function createServer (options = {}) {
  const { host = DEFAULT_HOST, port = DEFAULT_PORT, coin = 'dash', scenario = {} } = options
  const state = createState({ coin, scenario })

  const app = fastify({ logger: false })
  const requests = []
  // Root-level, so it also sees requests that end in a 404. A request the
  // worker must never make (a write method, or /control/*) is recorded in
  // state.violations so tests can assert there were none.
  app.addHook('onRequest', async (request) => {
    requests.push({ method: request.method, url: request.url })
    const read = request.method === 'GET' || request.method === 'HEAD'
    if (!read || request.url.startsWith('/control')) state.violations.push(`${request.method} ${request.url}`)
  })
  app.register(routes, { state })

  // The offline scenario drops every connection, as a node that went away.
  app.server.on('connection', (socket) => {
    if (state.scenario.offline) socket.destroy()
  })

  try {
    const nodeUrl = await app.listen({ host, port })
    return {
      app,
      state,
      requests,
      nodeUrl,
      setScenario (next) {
        state.setScenario(next)
        if (state.scenario.offline) app.server.closeAllConnections()
      },
      close: () => app.close()
    }
  } catch (err) {
    await app.close()
    throw err
  }
}

async function main () {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: DEFAULT_HOST },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      coin: { type: 'string', default: 'dash' }
    }
  })
  if (!COINS.includes(values.coin)) throw new Error(`--coin must be one of ${COINS.join(', ')}`)

  const { app, nodeUrl } = await createServer({ host: values.host, port: Number(values.port), coin: values.coin })
  console.log(`c2pool mock (${values.coin}) listening at ${nodeUrl}`)

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.close())
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { createServer }
