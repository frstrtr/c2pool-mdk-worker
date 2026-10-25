'use strict'

const http = require('node:http')
const path = require('node:path')
const { createState, loadFixture } = require('../mock/state')
const { C2poolApiError } = require('../src/errors')
const { parseConfig } = require('../src/config')
const { poll } = require('../src/snapshot')

const PKG_DIR = path.join(__dirname, '..')

// When each fixture set was captured (pplns/current.computed_at), in ms.
const CAPTURED_AT = Object.freeze({
  btc: 1792897120 * 1000,
  ltc: 1792896967 * 1000,
  dash: 1792897037 * 1000
})

const TYPE_OK = Object.freeze({
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
})

/**
 * A C2poolApi stand-in that serves the mock state (fixtures plus scenario)
 * without HTTP. `patch(path, body)` may rewrite a response.
 */
function stateApi (state, patch = (route, body) => body) {
  const calls = []
  return {
    calls,
    async get (route) {
      calls.push(route)
      if (state.failing(route)) throw new C2poolApiError(route, 500)
      return patch(route, structuredClone(state.body(route)))
    }
  }
}

/** Poll the recorded responses of one coin at its capture time. */
async function snapshotOf (coin, opts = {}, { scenario = {}, patch, now = CAPTURED_AT[coin] } = {}) {
  const state = createState({ coin, scenario })
  return poll(stateApi(state, patch), parseConfig(opts), { now })
}

/** A local port nothing listens on (bound, then released). */
async function freePort () {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function near (actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance
}

module.exports = { PKG_DIR, CAPTURED_AT, TYPE_OK, stateApi, snapshotOf, freePort, near, loadFixture, createState }
