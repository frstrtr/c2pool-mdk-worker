'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { ENDPOINTS } = require('./state')

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

/**
 * GET-only routes for the c2pool web API paths the fixtures cover.
 * Any other method on those paths answers 405; unknown paths answer 404.
 */
module.exports = async (app, { state }) => {
  app.addHook('onRequest', async () => {
    if (state.scenario.delayMs) await sleep(state.scenario.delayMs)
  })

  const json = (reply, code, body) => reply.code(code).type('application/json').send(JSON.stringify(body))

  for (const route of Object.keys(ENDPOINTS)) {
    app.get(route, async (request, reply) => {
      if (state.failing(route)) return json(reply, 500, { error: 'mock failure' })
      return json(reply, 200, state.body(route))
    })
    app.route({
      method: WRITE_METHODS,
      url: route,
      handler: async (request, reply) => json(reply, 405, { error: 'method not allowed' })
    })
  }

  // Like the real node: an unknown address answers 200 with an error body.
  app.get('/pplns/miner/:address', async (request, reply) => {
    if (request.params.address !== state.miner.address) return json(reply, 200, { error: 'miner_not_found' })
    return json(reply, 200, state.miner)
  })
}
