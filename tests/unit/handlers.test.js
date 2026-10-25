'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { loadContract, createInstance, validateContract } = require('../../src/mdk')
const { createServer } = require('../../mock/server')
const { PKG_DIR, TYPE_OK, freePort, snapshotOf } = require('../helpers')
const { MIN_POLL_INTERVAL_MS } = require('../../src/constants')
const contract = require('../../mdk-contract.json')
const { plugin } = require('../..')

let seq = 0
function instance (opts) {
  return createInstance({
    dir: PKG_DIR,
    entries: loadContract(PKG_DIR).entries,
    device: { id: `c2pool-${seq++}`, opts, env: {}, config: {} }
  })
}

async function mock (t, options = {}) {
  const server = await createServer({ port: 0, ...options })
  t.teardown(() => server.close())
  return server
}

async function metrics (inst) {
  const out = {}
  for (const [name, read] of inst.telemetry) {
    try {
      out[name] = await read({})
    } catch (err) {
      out[name] = { error: err.message }
    }
  }
  return out
}

test('the contract validates against the MDK schema and every handler loads', t => {
  const result = validateContract(contract, { dir: PKG_DIR })
  t.alike(result.errors, [])
  t.ok(result.ok)

  const loaded = loadContract(PKG_DIR)
  t.is(loaded.entries.telemetry.size, contract.capabilities.telemetry.length)
  t.is(loaded.entries.commands.size, 0, 'no commands')
  for (const entry of loaded.publishedContract.capabilities.telemetry) {
    t.is(entry.handler, undefined, `${entry.name}: handler path stripped from the published contract`)
  }
  const names = contract.capabilities.telemetry.map(e => e.name)
  t.absent(names.includes('balance'), 'no balance channel: a p2pool holds no balance')
  t.ok(names.includes('health'), 'health replaces the builtin')

  const inst = instance({})
  t.is(inst.telemetry.size, names.length, 'no builtin added on top')
  for (const fn of inst.telemetry.values()) t.is(typeof fn, 'function')
  t.is(plugin.dir, PKG_DIR)
  t.is(plugin.contract, contract)
})

test('every ERR_C2POOL_* code the source can raise is declared in the contract', t => {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.js')) files.push(file)
    }
  }
  walk(path.join(PKG_DIR, 'src'))
  const codes = new Set(files.flatMap(f => fs.readFileSync(f, 'utf8').match(/ERR_C2POOL_[A-Z_]+/g) || []))
  t.ok(codes.size > 10)
  for (const code of codes) t.ok(code in contract.capabilities.errors, `${code} is declared`)
})

test('the snapshot computes every contract channel but health', async t => {
  const snap = await snapshotOf('dash')
  const declared = contract.capabilities.telemetry.map(e => e.name).filter(n => n !== 'health')
  t.alike(Object.keys(snap.values).sort(), declared.sort())
})

test('every declared channel returns its declared type against the DASH mock', async t => {
  const server = await mock(t)
  const out = await metrics(instance({ nodeUrl: server.nodeUrl }))
  for (const entry of contract.capabilities.telemetry) {
    t.ok(TYPE_OK[entry.type](out[entry.name]), `${entry.name} is a ${entry.type}: ${JSON.stringify(out[entry.name]).slice(0, 80)}`)
  }
  t.ok(Math.abs(out.hashrate - 46.956e12) < 0.001e12)
  t.is(out.workers_online, 25)
  t.is(out.pending_payout, 0.41095312)
  t.is(out.coin, 'DASH')
  t.is(out.health.status, 'OK')
})

test('a metrics pull costs one poll; the identity is fetched once', async t => {
  const server = await mock(t)
  const inst = instance({ nodeUrl: server.nodeUrl })
  await metrics(inst)
  await metrics(inst)
  const count = (path) => server.requests.filter(r => r.url === path).length
  t.is(count('/local_stats'), 1)
  t.is(count('/stratum_stats'), 1)
  t.is(count('/node_info'), 1)
  t.is(count('/web/currency_info'), 1)
  t.is(server.requests.length, 9, 'seven per poll plus the two identity paths')
})

test('the worker only ever sends GET and never touches /control', async t => {
  for (const coin of ['dash', 'ltc', 'btc']) {
    const server = await mock(t, { coin })
    await metrics(instance({ nodeUrl: server.nodeUrl }))
    t.ok(server.requests.length > 0)
    t.ok(server.requests.every(r => r.method === 'GET'), `${coin}: GET only`)
    t.alike(server.state.violations, [], `${coin}: no write method, no /control`)
  }
})

test('no IP address or endpoint field anywhere in the metrics', async t => {
  for (const coin of ['dash', 'ltc', 'btc']) {
    const server = await mock(t, { coin })
    const text = JSON.stringify(await metrics(instance({ nodeUrl: server.nodeUrl })))
    t.absent(text.includes('203.0.113') || text.includes('2001:db8'), `${coin}: no IP`)
    t.absent(/remote_endpoint|ip_connections|ip_workers|external_ip/.test(text), `${coin}: no endpoint fields`)
  }
})

test('health turns OFFLINE and every other channel fails with an ERR_* once the node stops', { timeout: 30000 }, async t => {
  const server = await createServer({ port: 0 })
  const inst = instance({ nodeUrl: server.nodeUrl, pollIntervalMs: MIN_POLL_INTERVAL_MS })
  t.is((await inst.telemetry.get('health')({})).status, 'OK')

  await server.close()
  await sleep(MIN_POLL_INTERVAL_MS + 250)
  const out = await metrics(inst)
  t.alike(out.health, { status: 'OFFLINE', alerts: ['alert.pool_unreachable'], detail: { error: 'ERR_C2POOL_NODE_UNREACHABLE' } })
  for (const [name, value] of Object.entries(out)) {
    if (name === 'health') continue
    t.ok(/ERR_C2POOL_NODE_UNREACHABLE \/local_stats /.test(value.error), `${name}: ${value.error}`)
  }
})

test('bad config fails the channels, not the device', async t => {
  const server = await mock(t)
  const cases = [
    [{ nodeUrl: 'ftp://127.0.0.1' }, 'ERR_C2POOL_NODE_URL_INVALID'],
    [{ nodeUrl: server.nodeUrl, nodeURL: 'x' }, 'ERR_C2POOL_CONFIG_INVALID'],
    [{ nodeUrl: server.nodeUrl, addresses: ['a', 'a'] }, 'ERR_C2POOL_ADDRESS_INVALID'],
    [{ nodeUrl: server.nodeUrl, coin: 'LTC' }, 'ERR_C2POOL_COIN_MISMATCH']
  ]
  for (const [opts, code] of cases) {
    const inst = instance(opts)
    await t.exception(inst.telemetry.get('hashrate')({}), new RegExp(code), code)
    const health = await inst.telemetry.get('health')({})
    t.is(health.status, 'OFFLINE')
    t.is(health.detail.error, code)
  }
})

test('a relay node fails the local miner channels with ERR_C2POOL_RELAY_NODE', async t => {
  const server = await mock(t, { scenario: { relay: true } })
  const inst = instance({ nodeUrl: server.nodeUrl })
  await t.exception(inst.telemetry.get('hashrate')({}), /ERR_C2POOL_RELAY_NODE/)
  await t.exception(inst.telemetry.get('workers')({}), /ERR_C2POOL_RELAY_NODE/)
  t.is(await inst.telemetry.get('peers')({}), 3)
  t.is((await inst.telemetry.get('health')({})).status, 'OK')
})

test('an unreachable node surfaces as a telemetry error, not a load failure', async t => {
  const inst = instance({ nodeUrl: `http://127.0.0.1:${await freePort()}`, timeoutMs: 2000 })
  await t.exception(inst.telemetry.get('pending_payout')({}), /ERR_C2POOL_NODE_UNREACHABLE \/local_stats/)
  t.is((await inst.telemetry.get('health')({})).status, 'OFFLINE')
})

test('devices are isolated: two instances, two nodes', async t => {
  const dash = await mock(t, { coin: 'dash' })
  const ltc = await mock(t, { coin: 'ltc' })
  const a = instance({ nodeUrl: dash.nodeUrl, coin: 'DASH' })
  const b = instance({ nodeUrl: ltc.nodeUrl, coin: 'LTC' })
  t.is(await a.telemetry.get('coin')({}), 'DASH')
  t.is(await b.telemetry.get('coin')({}), 'LTC')
  t.alike(await b.telemetry.get('pending_payout_merged')({}), { DOGE: 0 })
  t.is(dash.requests.filter(r => r.url === '/local_stats').length, 1)
  t.is(ltc.requests.filter(r => r.url === '/local_stats').length, 1)
})
