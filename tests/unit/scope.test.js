'use strict'

const test = require('brittle')
const { parseUsername, scopeAddresses, inScope } = require('../../src/scope')
const { read } = require('../../src/snapshot')
const { snapshotOf } = require('../helpers')

const DASH_ADDR = 'XEXAMPLE1xxxxxxxxxxxxxxxxxxxxxxxxx'
const LTC_A = 'LEXAMPLE6xxxxxxxxxxxxxxxxxxxxxxxxx'
const LTC_B = 'LEXAMPLE4xxxxxxxxxxxxxxxxxxxxxxxxx'
const DOGE_A = 'DEXAMPLE7xxxxxxxxxxxxxxxxxxxxxxxxx'

test('stratum usernames: plain, dotted, merged, bare, with a difficulty suffix', t => {
  t.alike(parseUsername('ADDR.rig1'), { name: 'ADDR.rig1', addresses: ['ADDR'], primary: 'ADDR', worker: 'rig1' })
  t.alike(parseUsername('ADDR.rack2.rig1'), { name: 'ADDR.rack2.rig1', addresses: ['ADDR'], primary: 'ADDR', worker: 'rack2.rig1' })
  t.alike(parseUsername('LTC1,DOGE1.w'), { name: 'LTC1,DOGE1.w', addresses: ['LTC1', 'DOGE1'], primary: 'LTC1', worker: 'w' })
  t.alike(parseUsername('ADDR'), { name: 'ADDR', addresses: ['ADDR'], primary: 'ADDR', worker: '' })
  t.is(parseUsername('ADDR+512.rig1').primary, 'ADDR')
  t.is(parseUsername('ADDR/1024').primary, 'ADDR')
  t.is(parseUsername('').primary, '')
})

test('scope = configured addresses, else every address with a stratum session here', t => {
  const workers = [{ address: 'A' }, { address: 'B' }, { address: 'A' }, { address: '' }]
  t.alike([...scopeAddresses(workers, { addresses: [] })].sort(), ['A', 'B'])
  t.alike([...scopeAddresses(workers, { addresses: ['C'] })], ['C'])
  const scope = new Set(['A'])
  t.ok(inScope('A', scope))
  t.absent(inScope('a', scope), 'exact string match')
  t.absent(inScope(undefined, scope))
})

test('an address with nothing on this node and nothing in the window reads true zeros', async t => {
  const snap = await snapshotOf('dash', { addresses: ['XUNKNOWNxxxxxxxxxxxxxxxxxxxxxxxxxx'] })
  t.is(read(snap, 'hashrate'), 0)
  t.is(read(snap, 'pending_payout'), 0)
  t.is(read(snap, 'pplns_share'), 0)
  t.is(read(snap, 'workers_online'), 0)
  t.alike(read(snap, 'workers'), [])
})

test('the configured address gives the same reading as the default scope', async t => {
  const byDefault = await snapshotOf('dash')
  const configured = await snapshotOf('dash', { addresses: [DASH_ADDR] })
  for (const name of ['hashrate', 'workers_online', 'pending_payout', 'pplns_share']) {
    t.is(read(configured, name), read(byDefault, name), name)
  }
})

test('two addresses are summed', async t => {
  const snap = await snapshotOf('ltc', { addresses: [LTC_A, LTC_B] })
  t.is(read(snap, 'pending_payout'), 6.24359706)
  t.ok(Math.abs(read(snap, 'pplns_share') - (0.98962385815863 + 0.008699060561477727)) < 1e-12)
})

test('a merged-mining username is scoped by its primary address', async t => {
  const patch = (route, body) => {
    if (route === '/stratum_stats') {
      body.workers[`${LTC_A},${DOGE_A}.rig1`] = {
        accepted: 12,
        connected_seconds: 600,
        connection_difficulties: [512],
        connections: 1,
        dead_hash_rate: 0,
        difficulty: 512,
        hash_rate: 2e9,
        rejected: 0,
        remote_endpoint: '203.0.113.9:4000',
        silent: false,
        silent_seconds: 3,
        silent_threshold_seconds: 900,
        stale: 0,
        state: 'hashing',
        ever_submitted: true,
        last_share_age_s: 3
      }
    }
    return body
  }
  const byDefault = await snapshotOf('ltc', {}, { patch })
  t.is(read(byDefault, 'workers_online'), 1)
  t.is(read(byDefault, 'workers')[0].address, LTC_A)
  t.is(read(byDefault, 'pending_payout'), 6.18919239, 'the LTC address is now in scope')
  t.alike(read(byDefault, 'pending_payout_merged'), { DOGE: 9893.40760688 })

  const other = await snapshotOf('ltc', { addresses: [LTC_B] }, { patch })
  t.is(read(other, 'workers_online'), 0, 'not in a scope that names another address')
})
