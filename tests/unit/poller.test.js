'use strict'

const test = require('brittle')
const { Poller } = require('../../src/poller')
const { parseConfig } = require('../../src/config')
const { createState, stateApi, CAPTURED_AT } = require('../helpers')

function clock (start = CAPTURED_AT.dash) {
  let t = start
  const now = () => t
  now.advance = (ms) => { t += ms }
  return now
}

test('the poller shares one poll between concurrent readers and reuses it for pollIntervalMs', async t => {
  const state = createState({ coin: 'dash' })
  const api = stateApi(state)
  const now = clock()
  const poller = new Poller({ config: parseConfig({}), api, now })
  const polls = () => api.calls.filter(p => p === '/local_stats').length

  const [a, b, health] = await Promise.all([poller.get(), poller.get(), poller.health()])
  t.is(polls(), 1, 'one poll for three concurrent readers')
  t.is(a, b)
  t.is(health.status, 'OK')

  now.advance(29000)
  await poller.get()
  t.is(polls(), 1, 'reused within the interval')

  now.advance(2000)
  await poller.get()
  t.is(polls(), 2, 'polled again after the interval')
  t.is(api.calls.filter(p => p === '/node_info').length, 1, 'identity not refetched within the hour')
})

test('a failed poll is rethrown for 10 s, then retried; health reports OFFLINE meanwhile', async t => {
  const state = createState({ coin: 'dash', scenario: { error: true } })
  const api = stateApi(state)
  const now = clock()
  const poller = new Poller({ config: parseConfig({}), api, now })

  await t.exception(poller.get(), /ERR_C2POOL_HTTP \/local_stats 500/)
  t.is(api.calls.length, 1, 'the poll stops at /local_stats')
  t.alike(await poller.health(), { status: 'OFFLINE', alerts: ['alert.pool_unreachable'], detail: { error: 'ERR_C2POOL_HTTP' } })
  now.advance(9000)
  await t.exception(poller.get(), /ERR_C2POOL_HTTP/)
  t.is(api.calls.length, 1, 'cached failure, no new request')

  state.setScenario({})
  now.advance(1001)
  const snap = await poller.get()
  t.is(snap.values.coin, 'DASH', 'recovered after the error window')
  t.is((await poller.health()).status, 'OK')
})

test('health compares each snapshot with the previous successful one', async t => {
  const state = createState({ coin: 'dash' })
  const now = clock()
  const poller = new Poller({ config: parseConfig({ hashrateFloor: 50e12 }), api: stateApi(state), now })

  t.alike((await poller.health()).alerts, [], 'first poll below the floor')
  now.advance(31000)
  t.alike((await poller.health()).alerts, ['alert.hashrate_low'], 'second poll below the floor')

  state.setScenario({ error: true })
  now.advance(31000)
  t.is((await poller.health()).status, 'OFFLINE')

  state.setScenario({ hashrateScale: 2 })
  now.advance(10001)
  t.alike((await poller.health()).alerts, [], 'recovered above the floor')
})
