'use strict'

const fs = require('node:fs')
const path = require('node:path')

const FIXTURES = path.join(__dirname, 'fixtures')
const COINS = Object.freeze(['btc', 'ltc', 'dash'])

// Endpoint path -> recorded response (file name = path with '/' replaced by '_').
// The first group is what the worker reads; the rest was captured from the
// same nodes and is served so the mock answers like a real node.
const ENDPOINTS = Object.freeze({
  '/node_info': 'node_info',
  '/web/currency_info': 'web_currency_info',
  '/local_stats': 'local_stats',
  '/stratum_stats': 'stratum_stats',
  '/global_stats': 'global_stats',
  '/pplns/current': 'pplns_current',
  '/recent_blocks': 'recent_blocks',
  '/web/sync_status': 'web_sync_status',
  '/api/node_topology': 'api_node_topology',

  '/api/coin_peers': 'api_coin_peers',
  '/best_share': 'best_share',
  '/connected_miners': 'connected_miners',
  '/current_merged_payouts': 'current_merged_payouts',
  '/current_payouts': 'current_payouts',
  '/difficulty': 'difficulty',
  '/fee': 'fee',
  '/global_rate': 'global_rate',
  '/local_rate': 'local_rate',
  '/luck_stats': 'luck_stats',
  '/merged_stats': 'merged_stats',
  '/miner_thresholds': 'miner_thresholds',
  '/network_difficulty': 'network_difficulty',
  '/p2p_stats': 'p2p_stats',
  '/p2pool_global_stats': 'p2pool_global_stats',
  '/payout_addr': 'payout_addr',
  '/payout_addrs': 'payout_addrs',
  '/peer_list': 'peer_list',
  '/rate': 'rate',
  '/recent_merged_blocks': 'recent_merged_blocks',
  '/sharechain/stats': 'sharechain_stats',
  '/stale_rates': 'stale_rates',
  '/uptime': 'uptime',
  '/user_stales': 'user_stales',
  '/users': 'users',
  '/version_signaling': 'version_signaling',
  '/web/version': 'web_version'
})
// GET /pplns/miner/<address> is served from pplns_miner_addr.json (routes.js).
const MINER_FIXTURE = 'pplns_miner_addr'

function loadFixture (coin, name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, coin, `${name}.json`), 'utf8'))
}

/**
 * The mock node's state: the recorded responses of one coin, with a
 * scenario applied on top.
 *
 * Scenario knobs (all optional):
 *   offline        every connection is dropped (see server.js)
 *   error          true, a path, or a list of paths: answer 500
 *   delayMs        delay every response
 *   notSynced      web/sync_status.ready = false
 *   noPeers        local_stats.peers = 0 in, 0 out
 *   stalled: n     the first n workers (by name) went silent after sharing
 *   hashrateScale  multiply every local hashrate figure
 *   oldBuild       drop hashing/standby/stalled and per-worker state,
 *                  ever_submitted and last_share_age_s (pre-liveness build)
 *   relay          node_role 'relay', no stratum workers
 *   coinSymbol     override the symbol the node reports
 *
 * @param {{ coin?: 'btc'|'ltc'|'dash', scenario?: object }} [options]
 */
function createState ({ coin = 'dash', scenario = {} } = {}) {
  if (!COINS.includes(coin)) throw new Error(`unknown mock coin: ${coin}`)
  const recorded = {}
  for (const [route, name] of Object.entries(ENDPOINTS)) recorded[route] = loadFixture(coin, name)
  const miner = loadFixture(coin, MINER_FIXTURE)

  const state = {
    coin,
    scenario: {},
    responses: {},
    miner,
    // Requests the worker must never make: anything but GET/HEAD, or /control/*.
    violations: [],
    setScenario (next = {}) {
      this.scenario = { ...next }
      this.responses = applyScenario(structuredClone(recorded), this.scenario)
    },
    body (route) {
      return this.responses[route]
    },
    failing (route) {
      const { error } = this.scenario
      return error === true || error === route || (Array.isArray(error) && error.includes(route))
    }
  }
  state.setScenario(scenario)
  return state
}

function applyScenario (r, s) {
  const ls = r['/local_stats']
  const ss = r['/stratum_stats']

  if (s.notSynced) r['/web/sync_status'].ready = false

  if (s.noPeers) {
    ls.peers = { incoming: 0, outgoing: 0 }
    const warning = 'No pool peers connected — share propagation disabled'
    ls.warnings = [...(ls.warnings || []).filter(w => w !== warning), warning]
  }

  if (s.oldBuild) {
    if (ls.stratum_sessions) {
      for (const key of ['hashing', 'standby', 'stalled']) delete ls.stratum_sessions[key]
    }
    for (const key of ['connections_hashing', 'connections_standby', 'connections_stalled']) delete ss.pool[key]
    for (const w of Object.values(ss.workers)) {
      delete w.state
      delete w.ever_submitted
      delete w.last_share_age_s
    }
  }

  if (s.stalled) {
    const names = Object.keys(ss.workers).sort().slice(0, s.stalled)
    for (const name of names) {
      const w = ss.workers[name]
      const threshold = w.silent_threshold_seconds || 900
      w.silent = true
      w.silent_seconds = threshold * 2
      if ('state' in w) w.state = 'stalled'
      if ('last_share_age_s' in w) w.last_share_age_s = threshold * 2
      move(ss.pool, 'connections_active', 'connections_silent', w.connections)
      move(ss.pool, 'connections_hashing', 'connections_stalled', w.connections)
      move(ls.stratum_sessions, 'active', 'silent', w.connections)
      move(ls.stratum_sessions, 'hashing', 'stalled', w.connections)
    }
  }

  if (s.hashrateScale !== undefined) {
    const k = s.hashrateScale
    for (const w of Object.values(ss.workers)) {
      w.hash_rate *= k
      w.dead_hash_rate *= k
    }
    ss.pool.hashrate *= k
    if (typeof ls.local_hashps === 'number') ls.local_hashps *= k
    for (const map of [ls.miner_hash_rates, ls.miner_dead_hash_rates]) {
      for (const key of Object.keys(map || {})) map[key] *= k
    }
    for (const key of ['actual', 'nonstale', 'rewarded']) {
      if (typeof ls.my_hash_rates_in_last_hour?.[key] === 'number') ls.my_hash_rates_in_last_hour[key] *= k
    }
  }

  if (s.relay) {
    ls.node_role = 'relay'
    ls.local_hashps = 0
    ls.miner_hash_rates = {}
    ls.miner_dead_hash_rates = {}
    if (ls.stratum_sessions) {
      for (const key of Object.keys(ls.stratum_sessions)) {
        if (key !== 'silent_floor_seconds') ls.stratum_sessions[key] = 0
      }
    }
    ss.workers = {}
    for (const key of Object.keys(ss.pool)) {
      if (typeof ss.pool[key] === 'number' && key !== 'uptime') ss.pool[key] = 0
    }
    ss.pool.ip_connections = {}
    ss.pool.ip_workers = {}
  }

  if (s.coinSymbol) {
    r['/node_info'].symbol = s.coinSymbol
    r['/web/currency_info'].symbol = s.coinSymbol
  }

  return r
}

// Shift n from one counter to another, when the build reports both.
function move (counters, from, to, n) {
  if (counters && typeof counters[from] === 'number' && typeof counters[to] === 'number') {
    counters[from] -= n
    counters[to] += n
  }
}

module.exports = { createState, ENDPOINTS, COINS, FIXTURES, loadFixture }
