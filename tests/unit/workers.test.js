'use strict'

const test = require('brittle')
const { normalizeWorkers, deriveState } = require('../../src/workers')
const { loadFixture } = require('../helpers')

const ROW_KEYS = [
  'accepted', 'address', 'connected_seconds', 'connections', 'difficulty', 'hashrate', 'hashrate_dead',
  'last_share_age_s', 'name', 'rejected', 'stale', 'state', 'worker'
]

function worker (fields) {
  return {
    accepted: 0,
    connected_seconds: 1000,
    connection_difficulties: [1024],
    connections: 1,
    dead_hash_rate: 0,
    difficulty: 1024,
    first_seen: 1792880000,
    hash_rate: 1e12,
    last_seen: 1792881000,
    rejected: 0,
    remote_endpoint: '203.0.113.7:3333',
    rtt_ms: 20,
    shares: 0,
    silent: false,
    silent_seconds: 0,
    silent_threshold_seconds: 900,
    stale: 0,
    ...fields
  }
}

// The same three connections as a newer build reports them.
const NEW_BUILD = {
  'A.hashing': worker({ accepted: 10, silent_seconds: 5, state: 'hashing', ever_submitted: true, last_share_age_s: 5 }),
  'A.standby': worker({ state: 'standby', ever_submitted: false, last_share_age_s: null }),
  'A.stalled': worker({ accepted: 7, silent: true, silent_seconds: 2000, state: 'stalled', ever_submitted: true, last_share_age_s: 2000 })
}

function asOldBuild (workers) {
  const copy = structuredClone(workers)
  for (const w of Object.values(copy)) {
    delete w.state
    delete w.ever_submitted
    delete w.last_share_age_s
  }
  return copy
}

test('the old-build fallback derives what the new build reports', t => {
  const fresh = normalizeWorkers(NEW_BUILD).rows
  const old = normalizeWorkers(asOldBuild(NEW_BUILD)).rows
  t.alike(fresh.map(r => [r.name, r.state]), [['A.hashing', 'hashing'], ['A.stalled', 'stalled'], ['A.standby', 'standby']])
  t.alike(old, fresh, 'identical rows')
})

test('liveness rule', t => {
  t.is(deriveState(1, false), 'hashing')
  t.is(deriveState(1, true), 'stalled')
  t.is(deriveState(0, false), 'standby')
  t.is(deriveState(0, true), 'standby', 'never shared here: standby even when silent')
})

test('rows carry only the documented fields: no endpoint, rtt or timestamps', t => {
  const { rows } = normalizeWorkers(loadFixture('dash', 'stratum_stats').workers)
  t.is(rows.length, 25)
  for (const row of rows) t.alike(Object.keys(row).sort(), ROW_KEYS)
  t.absent(JSON.stringify(rows).includes('203.0.113'))
})

test('hashrate is net of dead work and never negative; gross keeps the total', t => {
  const { rows, gross } = normalizeWorkers({
    'A.r1': worker({ accepted: 1, hash_rate: 10, dead_hash_rate: 3 }),
    'A.r2': worker({ accepted: 1, hash_rate: 1, dead_hash_rate: 2 })
  })
  t.is(rows[0].hashrate, 7)
  t.is(rows[0].hashrate_dead, 3)
  t.is(rows[1].hashrate, 0)
  t.is(gross, 11)
})

test('an unknown state value falls back to the rule; a malformed number is an error', t => {
  const { rows } = normalizeWorkers({ 'A.r': worker({ accepted: 3, state: 'idle' }) })
  t.is(rows[0].state, 'hashing')
  t.exception(() => normalizeWorkers({ 'A.r': worker({ hash_rate: '1e12' }) }), /ERR_C2POOL_DATA stratum_stats.workers\[\].hash_rate/)
  t.exception(() => normalizeWorkers({ 'A.r': worker({ silent: 'no' }) }), /ERR_C2POOL_DATA stratum_stats.workers\[\].silent/)
  t.exception(() => normalizeWorkers([]), /ERR_C2POOL_DATA stratum_stats.workers/)
})

test('rows are sorted by name', t => {
  const { rows } = normalizeWorkers({ 'B.x': worker({}), 'A.y': worker({}), 'A.b': worker({}) })
  t.alike(rows.map(r => r.name), ['A.b', 'A.y', 'B.x'])
})
