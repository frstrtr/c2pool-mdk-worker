'use strict'

const test = require('brittle')
const { snapshotOf, near, loadFixture, createState, stateApi, CAPTURED_AT } = require('../helpers')
const { read, poll } = require('../../src/snapshot')
const { parseConfig } = require('../../src/config')
// Every telemetry channel except health, which is evaluated from the snapshot.
const CHANNELS = [
  'hashrate', 'hashrate_dead', 'workers_online', 'workers_stalled', 'workers_standby', 'workers',
  'pplns_share', 'pending_payout', 'pending_payout_merged', 'estimated_earnings', 'expected_blocks_per_day',
  'pool_hashrate', 'network_difficulty', 'network_hashrate', 'block_value', 'blocks_found_24h',
  'last_block_found', 'share_difficulty', 'stale_rate', 'efficiency', 'sharechain', 'peers', 'coin', 'node'
]
const LTC_ADDRESSES = loadFixture('ltc', 'pplns_current').miners.map(m => m.address)

test('every fixture coin parses into a value or a coded error for every channel', async t => {
  for (const coin of ['btc', 'ltc', 'dash']) {
    const snap = await snapshotOf(coin)
    t.alike(Object.keys(snap.values).sort(), [...CHANNELS].sort(), `${coin}: one entry per declared channel`)
    for (const name of CHANNELS) {
      const v = snap.values[name]
      if (v instanceof Error) t.ok(/ERR_C2POOL_/.test(v.message), `${coin}.${name} fails with ${v.message}`)
    }
    t.ok(Object.isFrozen(snap.values), `${coin}: snapshot is frozen`)
  }
})

test('DASH: 25 rigs on one address, older build without per-worker state', async t => {
  const raw = loadFixture('dash', 'stratum_stats')
  const localStats = loadFixture('dash', 'local_stats')
  t.absent(Object.values(raw.workers).some(w => 'state' in w), 'fixture has no state key')

  const snap = await snapshotOf('dash')
  const hashrate = read(snap, 'hashrate')
  t.ok(near(hashrate, raw.pool.hashrate, 1), 'hashrate = sum of workers = stratum pool.hashrate (46.956 TH/s)')
  t.ok(near(hashrate, 46.956e12, 0.001e12))
  t.is(read(snap, 'hashrate_dead'), 0)

  const minerSum = Object.values(localStats.miner_hash_rates).reduce((a, b) => a + b, 0)
  t.ok(near(snap.facts.local_hashps, 44.42e12, 0.01e12), 'local_hashps is the acceptor estimator, 44.42 TH/s')
  t.ok(Math.abs(snap.facts.local_hashps - minerSum) / minerSum < 0.1, 'local_hashps within 10 % of the per-miner sum')
  t.ok(Math.abs(snap.facts.local_hashps - hashrate) / hashrate < 0.1, 'and of the stratum hashrate')
  t.ok(near(snap.facts.stratum_hashrate, raw.pool.hashrate, 1))

  t.is(read(snap, 'workers_online'), 25, 'states derived from accepted/silent')
  t.is(read(snap, 'workers_stalled'), 0)
  t.is(read(snap, 'workers_standby'), 0)
  const workers = read(snap, 'workers')
  t.is(workers.length, 25)
  t.is(workers[0].name, 'XEXAMPLE1xxxxxxxxxxxxxxxxxxxxxxxxx.D1', 'sorted by name')
  t.is(workers[0].address, 'XEXAMPLE1xxxxxxxxxxxxxxxxxxxxxxxxx')
  t.is(workers[0].worker, 'D1')
  t.is(workers[0].state, 'hashing')
  t.is(workers[0].last_share_age_s, 0, 'silent_seconds stands in for last_share_age_s')

  t.is(read(snap, 'pending_payout'), 0.41095312)
  t.ok(near(read(snap, 'pplns_share'), 1, 1e-6))
  t.alike(read(snap, 'pending_payout_merged'), {})
  t.ok(near(read(snap, 'expected_blocks_per_day'), 4.54, 0.005), '4.54 blocks/day')
  t.ok(near(read(snap, 'estimated_earnings'), 1.866, 0.001), '1.87 DASH/day')
  t.is(read(snap, 'blocks_found_24h'), 3, 'the three fixture rows are within 24 h of the capture')
  t.alike(read(snap, 'last_block_found'), {
    height: 2560808,
    hash: '00000000000000056460ed6214d07165c9b885cc8b6e8d0dd454c8bbea52adcd',
    ts: 1792873777,
    found_by: 'this_node',
    status: 'confirmed',
    confirmations: 1,
    block_reward: 1.64462775,
    explorer_url: 'https://blockchair.com/dash/block/00000000000000056460ed6214d07165c9b885cc8b6e8d0dd454c8bbea52adcd'
  })
  t.ok(near(read(snap, 'share_difficulty'), 5430.892, 0.001))
  t.is(read(snap, 'network_hashrate'), 154979336.73131877 * 4294967296 / 150)
  t.is(read(snap, 'coin'), 'DASH')
  t.is(read(snap, 'peers'), 3)
  t.is(read(snap, 'stale_rate'), 0)
  t.is(read(snap, 'efficiency'), 1)

  t.alike(read(snap, 'block_value'), {
    total: 1.64378041,
    miner_net: 0.41094511,
    miner_gross: 0.41094511,
    fee: 0,
    payments: 1.2328353,
    basis: 'template',
    height: 2560960,
    age_sec: 21,
    fee_percent: 0
  })

  const sharechain = read(snap, 'sharechain')
  t.is(sharechain.synced, true)
  t.is(sharechain.shares_in_window, 4320)
  t.is(sharechain.window_size, 8787)
  t.is(sharechain.peers_in, 3)
  t.ok(near(sharechain.local_orphan_rate, 0.0212, 0.0001), 'DASH build reports local_shares.orphan_rate')
  t.is(sharechain.share_version, 16)
  t.is(sharechain.coin_chain.synced, true)
  t.is(sharechain.coin_chain.height, 2560962)

  const node = read(snap, 'node')
  t.is(node.role, 'mining')
  t.is(node.network, 'dash')
  t.is(node.worker_port, 7903)
  t.alike(node.warnings, [])
})

test('LTC: merged DOGE, no local miners, four payout addresses in the window', async t => {
  const idle = await snapshotOf('ltc')
  t.alike(read(idle, 'workers'), [], 'no stratum sessions: empty scope')
  t.is(read(idle, 'hashrate'), 0)
  t.is(read(idle, 'workers_online'), 0)
  t.is(read(idle, 'pending_payout'), 0)
  t.is(read(idle, 'pplns_share'), 0)
  t.alike(read(idle, 'pending_payout_merged'), { DOGE: 0 }, 'every merged chain is listed')

  const all = await snapshotOf('ltc', { addresses: LTC_ADDRESSES })
  t.alike(read(all, 'pending_payout_merged'), { DOGE: 9895.91847226 }, 'equals merged_totals')
  t.is(read(all, 'pending_payout'), 6.25408567, 'equals total_primary')

  const one = await snapshotOf('ltc', { addresses: ['LEXAMPLE6xxxxxxxxxxxxxxxxxxxxxxxxx'], coin: 'ltc' })
  t.is(read(one, 'pending_payout'), 6.18919239)
  t.ok(near(read(one, 'pplns_share'), 0.9896, 0.0001))
  t.alike(read(one, 'pending_payout_merged'), { DOGE: 9893.40760688 })
  t.ok(near(read(one, 'expected_blocks_per_day'), 0.0381, 0.0001), 'one block per ~26 days')
  t.ok(near(read(one, 'estimated_earnings'), 0.236, 0.001))

  const bv = read(one, 'block_value')
  t.is(bv.basis, null, 'this build does not report the basis')
  t.is(bv.height, null)
  t.is(bv.total, 6.25445146)
  t.is(read(one, 'blocks_found_24h'), 0, 'the only block is 2.4 days old')
  t.is(read(one, 'last_block_found').status, 'pending')
  t.is(read(one, 'last_block_found').block_reward, null)
  t.absent('local_orphan_rate' in read(one, 'sharechain'))
  t.is(read(one, 'sharechain').coin_chain.synced, true)
  t.alike(read(one, 'node').warnings, ['No miners connected — pool is idle'])
  t.alike(one.identity.merged, ['DOGE'])
})

test('BTC (BIP110 lane): idle node, no blocks, young sharechain', async t => {
  const snap = await snapshotOf('btc', { coin: 'BTC', addresses: ['bc1qexample3qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'] })
  t.is(read(snap, 'coin'), 'BIP110', 'reported verbatim; satisfies coin BTC')
  t.is(read(snap, 'last_block_found'), null)
  t.is(read(snap, 'blocks_found_24h'), 0)
  t.exception(() => read(snap, 'share_difficulty'), /ERR_C2POOL_DATA global_stats.min_difficulty/)

  const nodeFigure = loadFixture('btc', 'global_stats').network_hashrate
  t.is(read(snap, 'network_hashrate'), 5943717411.5921955 * 4294967296 / 600, 'uses the 600 s block period')
  t.ok(near(nodeFigure / read(snap, 'network_hashrate'), 4, 1e-9), 'the node figure is 4x too high')

  t.ok(near(read(snap, 'expected_blocks_per_day'), 1.09e-6, 0.01e-6))
  t.is(read(snap, 'pending_payout'), 3.12185282)
  t.ok(near(read(snap, 'estimated_earnings'), 3.4e-6, 0.01e-6), 'numerically honest and useless')
  t.is(read(snap, 'block_value').basis, 'projected')
  t.is(read(snap, 'block_value').age_sec, null)
  t.is(read(snap, 'node').warnings.length, 2)
  t.is(read(snap, 'sharechain').coin_chain.synced, false)
  t.ok(near(read(snap, 'sharechain').coin_chain.sync_percent, 99.94, 0.01))
})

test('no IP address or endpoint survives into the snapshot', async t => {
  for (const coin of ['btc', 'ltc', 'dash']) {
    const snap = await snapshotOf(coin)
    const text = JSON.stringify(snap.values) + JSON.stringify(snap.facts) + JSON.stringify(snap.identity)
    t.absent(text.includes('203.0.113'), `${coin}: no IPv4`)
    t.absent(text.includes('2001:db8'), `${coin}: no IPv6`)
    t.absent(/remote_endpoint|ip_connections|ip_workers|external_ip/.test(text), `${coin}: no endpoint fields`)
  }
})

test('a configured coin must match the node', async t => {
  await t.exception(snapshotOf('btc', { coin: 'LTC' }), /ERR_C2POOL_COIN_MISMATCH/)
  await t.exception(snapshotOf('dash', { coin: 'btc' }), /ERR_C2POOL_COIN_MISMATCH node reports DASH/)
  const ok = await snapshotOf('ltc', { coin: 'LTC' })
  t.is(read(ok, 'coin'), 'LTC')
})

test('a node that is not ready fails the payout channels, not the others', async t => {
  const snap = await snapshotOf('dash', {}, { scenario: { notSynced: true } })
  for (const name of ['pplns_share', 'pending_payout', 'pending_payout_merged', 'estimated_earnings']) {
    t.exception(() => read(snap, name), /ERR_C2POOL_NOT_READY/, name)
  }
  t.is(read(snap, 'workers_online'), 25)
  t.is(read(snap, 'sharechain').synced, false)
})

test('one malformed field fails its own channel only', async t => {
  const patch = (route, body) => {
    if (route === '/local_stats') body.efficiency = 'n/a'
    return body
  }
  const snap = await snapshotOf('dash', {}, { patch })
  t.exception(() => read(snap, 'efficiency'), /ERR_C2POOL_DATA local_stats.efficiency/)
  t.is(read(snap, 'workers_online'), 25)

  const badWorkers = await snapshotOf('dash', {}, {
    patch: (route, body) => {
      if (route === '/stratum_stats') Object.values(body.workers)[0].hash_rate = '1e12'
      return body
    }
  })
  t.exception(() => read(badWorkers, 'hashrate'), /ERR_C2POOL_DATA stratum_stats.workers\[\].hash_rate/)
  t.exception(() => read(badWorkers, 'pending_payout'), /ERR_C2POOL_DATA/, 'scope comes from the workers, so it fails too')
  t.is(read(badWorkers, 'pool_hashrate'), 34976790374428)
})

test('a response of the wrong shape fails the poll', async t => {
  const patch = (route, body) => (route === '/local_stats' ? [body] : body)
  await t.exception(snapshotOf('dash', {}, { patch }), /ERR_C2POOL_DATA \/local_stats/)
  const notArray = (route, body) => (route === '/recent_blocks' ? {} : body)
  await t.exception(snapshotOf('dash', {}, { patch: notArray }), /ERR_C2POOL_DATA \/recent_blocks/)
})

test('a relay node has no local miners', async t => {
  const snap = await snapshotOf('dash', { addresses: ['XEXAMPLE1xxxxxxxxxxxxxxxxxxxxxxxxx'] }, { scenario: { relay: true } })
  for (const name of ['hashrate', 'hashrate_dead', 'workers_online', 'workers_stalled', 'workers_standby', 'workers']) {
    t.exception(() => read(snap, name), /ERR_C2POOL_RELAY_NODE/, name)
  }
  t.is(read(snap, 'pending_payout'), 0.41095312, 'the PPLNS view still works for configured addresses')
  t.is(read(snap, 'node').role, 'relay')
})

test('/api/node_topology is optional', async t => {
  const snap = await snapshotOf('dash', {}, { scenario: { error: '/api/node_topology' } })
  t.absent('coin_chain' in read(snap, 'sharechain'))
  t.is(snap.facts.topology_error, 'ERR_C2POOL_HTTP')
  t.is(snap.facts.coin_chain_synced, null)
})

test('the node identity is fetched on the first poll and then once an hour', async t => {
  const state = createState({ coin: 'dash' })
  const config = parseConfig({})
  const api = stateApi(state)
  const now = CAPTURED_AT.dash
  const first = await poll(api, config, { now })
  t.ok(api.calls.includes('/node_info'))
  t.ok(api.calls.includes('/web/currency_info'))
  t.is(api.calls[0], '/local_stats', '/local_stats goes first')

  api.calls.length = 0
  await poll(api, config, { now: now + 30000, identity: first.identity })
  t.absent(api.calls.includes('/node_info'), 'reused within the hour')
  t.is(api.calls.length, 7)

  api.calls.length = 0
  await poll(api, config, { now: now + 3600000, identity: first.identity })
  t.ok(api.calls.includes('/node_info'), 'refetched after an hour')
})

test('recentBlocks limits the rows read', async t => {
  const snap = await snapshotOf('dash', { recentBlocks: 1 })
  t.is(read(snap, 'blocks_found_24h'), 1)
  const later = await snapshotOf('dash', {}, { now: CAPTURED_AT.dash + 86400 * 1000 })
  t.is(read(later, 'blocks_found_24h'), 0, 'a day later none of them count')
})
