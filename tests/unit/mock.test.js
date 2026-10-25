'use strict'

const test = require('brittle')
const { createServer } = require('../../mock/server')
const { createState, ENDPOINTS, loadFixture } = require('../../mock/state')
const { PATHS } = require('../../src/constants')

async function mock (t, options = {}) {
  const server = await createServer({ port: 0, ...options })
  t.teardown(() => server.close())
  return server
}

async function get (server, path) {
  const res = await fetch(server.nodeUrl + path)
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() }
}

test('serves every recorded endpoint of each coin verbatim', async t => {
  for (const coin of ['btc', 'ltc', 'dash']) {
    const server = await mock(t, { coin })
    for (const [path, name] of Object.entries(ENDPOINTS)) {
      const res = await get(server, path)
      t.is(res.status, 200, `${coin} ${path}`)
      t.ok(res.type.startsWith('application/json'))
      t.alike(res.body, loadFixture(coin, name))
    }
  }
})

test('covers every path the worker reads', t => {
  for (const path of PATHS) t.ok(path in ENDPOINTS, path)
})

test('other methods answer 405, unknown paths 404, and both are recorded as violations', async t => {
  const server = await mock(t)
  const post = await fetch(`${server.nodeUrl}/local_stats`, { method: 'POST', body: '{}' })
  t.is(post.status, 405)
  const unknown = await fetch(`${server.nodeUrl}/control/mining`)
  t.is(unknown.status, 404)
  t.alike(server.state.violations, ['POST /local_stats', 'GET /control/mining'])
})

test('/pplns/miner/<address> answers 200 with an error body for an unknown address, like the node', async t => {
  const server = await mock(t)
  const known = loadFixture('dash', 'pplns_miner_addr')
  t.alike((await get(server, `/pplns/miner/${known.address}`)).body, known)
  const unknown = await get(server, '/pplns/miner/XNOPE')
  t.is(unknown.status, 200)
  t.alike(unknown.body, { error: 'miner_not_found' })
})

test('scenario: notSynced, noPeers, relay, coinSymbol', t => {
  t.is(createState({ scenario: { notSynced: true } }).body('/web/sync_status').ready, false)

  const noPeers = createState({ scenario: { noPeers: true } }).body('/local_stats')
  t.alike(noPeers.peers, { incoming: 0, outgoing: 0 })
  t.ok(noPeers.warnings.some(w => w.startsWith('No pool peers connected')))

  const relay = createState({ scenario: { relay: true } })
  t.is(relay.body('/local_stats').node_role, 'relay')
  t.alike(relay.body('/stratum_stats').workers, {})
  t.is(relay.body('/stratum_stats').pool.hashrate, 0)
  t.alike(relay.body('/stratum_stats').pool.ip_connections, {})

  const renamed = createState({ coin: 'btc', scenario: { coinSymbol: 'LTC' } })
  t.is(renamed.body('/node_info').symbol, 'LTC')
})

test('scenario: stalled marks the first n workers silent after sharing', t => {
  const state = createState({ scenario: { stalled: 3 } })
  const workers = state.body('/stratum_stats').workers
  const silent = Object.keys(workers).filter(name => workers[name].silent)
  t.is(silent.length, 3)
  t.alike(silent.sort(), Object.keys(workers).sort().slice(0, 3))
  t.ok(silent.every(name => workers[name].accepted > 0 && workers[name].silent_seconds > workers[name].silent_threshold_seconds))
  t.is(state.body('/stratum_stats').pool.connections_silent, 3)
  t.is(state.body('/local_stats').stratum_sessions.silent, 3)
})

test('scenario: hashrateScale and oldBuild', t => {
  const base = createState({ coin: 'dash' })
  const half = createState({ coin: 'dash', scenario: { hashrateScale: 0.5 } })
  t.is(half.body('/stratum_stats').pool.hashrate, base.body('/stratum_stats').pool.hashrate * 0.5)
  t.is(half.body('/local_stats').local_hashps, base.body('/local_stats').local_hashps * 0.5)

  const ltc = createState({ coin: 'ltc' })
  t.ok('hashing' in ltc.body('/local_stats').stratum_sessions, 'the LTC build reports hashing/standby/stalled')
  const old = createState({ coin: 'ltc', scenario: { oldBuild: true } })
  t.absent('hashing' in old.body('/local_stats').stratum_sessions)
  t.absent('connections_hashing' in old.body('/stratum_stats').pool)
})

test('scenario: error answers 500 for all or some paths', async t => {
  const all = await mock(t, { scenario: { error: true } })
  t.is((await fetch(`${all.nodeUrl}/local_stats`)).status, 500)

  const one = await mock(t, { scenario: { error: '/global_stats' } })
  t.is((await fetch(`${one.nodeUrl}/global_stats`)).status, 500)
  t.is((await fetch(`${one.nodeUrl}/local_stats`)).status, 200)
})

test('scenario: delayMs and offline', async t => {
  const slow = await mock(t, { scenario: { delayMs: 150 } })
  const started = Date.now()
  await fetch(`${slow.nodeUrl}/uptime`)
  t.ok(Date.now() - started >= 140)

  const server = await mock(t)
  t.is((await fetch(`${server.nodeUrl}/uptime`)).status, 200)
  server.setScenario({ offline: true })
  await t.exception.all(fetch(`${server.nodeUrl}/uptime`), 'connections are dropped')
  server.setScenario({})
  t.is((await fetch(`${server.nodeUrl}/uptime`)).status, 200)
})

test('scenarios do not leak between states', t => {
  createState({ scenario: { relay: true, notSynced: true } })
  const clean = createState()
  t.is(clean.body('/local_stats').node_role, 'mining')
  t.is(clean.body('/web/sync_status').ready, true)
  t.is(Object.keys(clean.body('/stratum_stats').workers).length, 25)
})
