'use strict'

const test = require('brittle')
const { evaluate, offline, isStale } = require('../../src/health')
const { parseConfig } = require('../../src/config')
const { C2poolApiError, ConfigError } = require('../../src/errors')
const { snapshotOf } = require('../helpers')

async function healthOf (coin, opts = {}, options = {}, previous = null) {
  const snap = await snapshotOf(coin, opts, options)
  return { snap, health: evaluate(snap, previous, parseConfig(opts)) }
}

test('DASH fixture: OK, both hashrate estimators visible, no config echoed', async t => {
  const { health } = await healthOf('dash', { nodeUrl: 'http://127.0.0.1:18080', hashrateFloor: 1e12 })
  t.is(health.status, 'OK')
  t.alike(health.alerts, [])
  t.is(health.detail.workers_online, 25)
  t.is(health.detail.peers, 3)
  t.is(health.detail.coin_p2p_state, 'connected')
  t.ok(health.detail.local_hashps > 4e13)
  t.ok(health.detail.stratum_hashrate > 4e13)
  t.alike(health.detail.stalled_workers, [])
  const text = JSON.stringify(health)
  t.absent(text.includes('18080') || text.includes('nodeUrl') || text.includes('hashrateFloor'), 'config never echoed')
})

test('BTC fixture: coin chain not synced and no peers; notes carry the projected template and node warnings', async t => {
  const { health } = await healthOf('btc')
  t.is(health.status, 'DEGRADED')
  t.alike(health.alerts.sort(), ['alert.no_peers', 'alert.sharechain_not_synced'])
  t.is(health.detail.coin_chain_synced, false)
  t.is(health.detail.sync_ready, true)
  t.ok(health.detail.notes.some(n => n.startsWith('block value is projected')))
  t.ok(health.detail.notes.includes('node: No miners connected — pool is idle'))
})

test('LTC fixture: OK with no local miners', async t => {
  const { health } = await healthOf('ltc')
  t.is(health.status, 'OK')
  t.is(health.detail.connections, 0)
})

test('alert.sharechain_not_synced on sync_status.ready false', async t => {
  const { health } = await healthOf('dash', {}, { scenario: { notSynced: true } })
  t.alike(health.alerts, ['alert.sharechain_not_synced'])
  t.is(health.status, 'DEGRADED')
})

test('alert.no_peers on zero sharechain peers or a disconnected coin P2P client', async t => {
  const noPeers = await healthOf('dash', {}, { scenario: { noPeers: true } })
  t.alike(noPeers.health.alerts, ['alert.no_peers'])

  const patch = (route, body) => {
    if (route === '/local_stats') body.coin_p2p.state = 'dialing'
    return body
  }
  const p2p = await healthOf('dash', {}, { patch })
  t.alike(p2p.health.alerts, ['alert.no_peers'])
  t.is(p2p.health.detail.coin_p2p_state, 'dialing')
})

test('alert.workers_stalled names the stalled workers', async t => {
  const { health } = await healthOf('dash', {}, { scenario: { stalled: 2 } })
  t.alike(health.alerts, ['alert.workers_stalled'])
  t.is(health.detail.workers_stalled, 2)
  t.is(health.detail.workers_online, 23)
  t.alike(health.detail.stalled_workers, ['XEXAMPLE1xxxxxxxxxxxxxxxxxxxxxxxxx.D1', 'XEXAMPLE1xxxxxxxxxxxxxxxxxxxxxxxxx.D10'])
})

test('alert.hashrate_low needs two consecutive polls below the floor', async t => {
  const opts = { hashrateFloor: 50e12 }
  const low = await healthOf('dash', opts)
  t.alike(low.health.alerts, [], 'first poll below the floor: not yet')
  t.is(low.health.detail.previous_hashrate, null)

  const second = await healthOf('dash', opts, {}, low.snap)
  t.alike(second.health.alerts, ['alert.hashrate_low'], 'second poll below: fires')
  t.ok(second.health.detail.previous_hashrate < 50e12)

  const recovered = await healthOf('dash', opts, { scenario: { hashrateScale: 2 } }, second.snap)
  t.alike(recovered.health.alerts, [], 'one poll at or above the floor clears it')

  const afterSpike = await healthOf('dash', opts, {}, recovered.snap)
  t.alike(afterSpike.health.alerts, [], 'previous poll was above the floor')

  const off = await healthOf('dash', {}, {}, low.snap)
  t.alike(off.health.alerts, [], 'no floor configured: never evaluated')
  t.absent('previous_hashrate' in off.health.detail)
})

function standbyPatch (connectedSeconds) {
  return (route, body) => {
    if (route === '/stratum_stats') {
      for (const w of Object.values(body.workers)) {
        w.accepted = 0
        w.connected_seconds = connectedSeconds
      }
    }
    return body
  }
}

test('alert.no_recent_shares: connected long enough, nothing accepted', async t => {
  const fires = await healthOf('dash', {}, { patch: standbyPatch(1000) })
  t.alike(fires.health.alerts, ['alert.no_recent_shares'])
  t.is(fires.health.detail.workers_standby, 25)

  const young = await healthOf('dash', {}, { patch: standbyPatch(100) })
  t.alike(young.health.alerts, [], 'connections younger than noShareAlertMs')

  const shorter = await healthOf('dash', { noShareAlertMs: 60000 }, { patch: standbyPatch(100) })
  t.alike(shorter.health.alerts, ['alert.no_recent_shares'], 'threshold follows noShareAlertMs')

  const elsewhere = await healthOf('dash', { addresses: ['XOTHERxxxxxxxxxxxxxxxxxxxxxxxxxxxx'] }, { patch: standbyPatch(1000) })
  t.alike(elsewhere.health.alerts, [], 'suppressed when the configured address has no rigs here')
})

test('a relay node skips the local miner rules', async t => {
  const { health } = await healthOf('dash', { hashrateFloor: 1e15 }, { scenario: { relay: true } })
  t.is(health.status, 'OK')
  t.ok(health.detail.notes.some(n => n.startsWith('node role is relay')))
  t.absent('hashrate' in health.detail)
})

test('a rule whose input is malformed is skipped, says so, and the node is not OK', async t => {
  const patch = (route, body) => {
    if (route === '/web/sync_status') body.ready = 'yes'
    return body
  }
  const { health } = await healthOf('dash', {}, { patch })
  t.is(health.status, 'DEGRADED')
  t.alike(health.alerts, ['alert.data_unavailable'])
  t.alike(health.detail.unavailable, ['sync_ready'])
  t.is(health.detail.sync_ready, null)
  t.ok(health.detail.notes.some(n => n.startsWith('alert.sharechain_not_synced not evaluated: ERR_C2POOL_DATA web/sync_status.ready')))
})

test('alert.data_unavailable for each input an alert rule needs', async t => {
  const cases = [
    ['/local_stats', body => { body.peers = 'three' }, ['peers']],
    ['/local_stats', body => { body.coin_p2p = { state: 1 } }, ['coin_p2p_state']],
    ['/local_stats', body => { body.node_role = 7 }, ['relay']],
    ['/stratum_stats', body => { Object.values(body.workers)[0].silent = 'no' }, ['hashrate', 'scoped']]
  ]
  for (const [route, edit, names] of cases) {
    const patch = (r, body) => {
      if (r === route) edit(body)
      return body
    }
    const { health } = await healthOf('dash', {}, { patch })
    t.is(health.status, 'DEGRADED', names.join(','))
    t.ok(health.alerts.includes('alert.data_unavailable'))
    t.alike(health.detail.unavailable, names)
  }
})

test('a relay node does not count its local miner channels as unavailable', async t => {
  const { health } = await healthOf('dash', {}, { scenario: { relay: true } })
  t.alike(health.alerts, [])
  t.absent('unavailable' in health.detail)
})

test('a stale block template is noted', async t => {
  const patch = (route, body) => {
    if (route === '/local_stats') body.block_value_age_sec = 1000
    return body
  }
  const { health } = await healthOf('dash', {}, { patch })
  t.ok(health.detail.notes.includes('block template is 1000 s old, more than 3 block periods'))
})

test('OFFLINE carries alert.pool_unreachable and the error code only', t => {
  t.alike(offline(new C2poolApiError('/local_stats', 0, 'ECONNREFUSED')), {
    status: 'OFFLINE',
    alerts: ['alert.pool_unreachable'],
    detail: { error: 'ERR_C2POOL_NODE_UNREACHABLE' }
  })
  t.is(offline(new ConfigError('ERR_C2POOL_NODE_URL_INVALID')).detail.error, 'ERR_C2POOL_NODE_URL_INVALID')
  t.is(offline(new Error('socket hang up')).detail.error, 'E_POOL_API')
})

test('a snapshot older than three poll intervals is stale', t => {
  const config = parseConfig({ pollIntervalMs: 10000 })
  t.absent(isStale({ at: 0 }, config, 30000))
  t.ok(isStale({ at: 0 }, config, 30001))
})
