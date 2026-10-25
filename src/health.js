'use strict'

const { errorCode } = require('./errors')
const { sum } = require('./utils/numbers')
const { STALE_POLLS, MAX_NOTES, MAX_WORKER_ROWS } = require('./constants')

/**
 * Health of one successful poll: a pure function of the snapshot, the
 * previous successful snapshot (for the two-poll hashrate rule) and the
 * device config.
 *
 * `detail` carries the numbers each rule used and the names of stalled
 * workers; it never echoes the config. A rule whose input failed to parse is
 * skipped and says so in `detail.notes`; the status is then not OK:
 * alert.data_unavailable fires and `detail.unavailable` names the inputs.
 *
 * @returns {{ status: 'OK'|'DEGRADED', alerts: string[], detail: object }}
 */
function evaluate (snapshot, previous, config) {
  const alerts = []
  const notes = []
  const detail = {}
  const unavailable = []
  const { values, facts } = snapshot

  const value = (source, name, rule) => {
    const v = source[name]
    if (v instanceof Error) {
      notes.push(`${rule} not evaluated: ${v.message}`)
      return undefined
    }
    return v
  }
  // An input an alert rule cannot do without: if it failed to parse, the
  // rule was not evaluated, so the node cannot be reported OK.
  const required = (source, name, rule) => {
    if (source[name] instanceof Error) unavailable.push(name)
    return value(source, name, rule)
  }

  // alert.sharechain_not_synced: the node's own readiness gate, or the coin
  // header follower behind, when the build reports it.
  const ready = required(facts, 'sync_ready', 'alert.sharechain_not_synced')
  const coinSynced = value(facts, 'coin_chain_synced', 'alert.sharechain_not_synced')
  detail.sync_ready = ready ?? null
  detail.coin_chain_synced = coinSynced ?? null
  if (ready === false || coinSynced === false) alerts.push('alert.sharechain_not_synced')

  // alert.no_peers: no sharechain peers, so shares cannot propagate; or the
  // embedded coin P2P client (DASH build) is not connected.
  const peers = required(facts, 'peers', 'alert.no_peers')
  const p2p = required(facts, 'coin_p2p_state', 'alert.no_peers')
  detail.peers = peers ?? null
  if (typeof p2p === 'string') detail.coin_p2p_state = p2p
  if (peers === 0 || (typeof p2p === 'string' && p2p !== 'connected')) alerts.push('alert.no_peers')

  const relay = required(facts, 'relay', 'local miner rules')
  if (relay === true) {
    notes.push('node role is relay: no stratum acceptor, local miner rules not evaluated')
  } else if (relay === false) {
    localMinerRules({ values, facts, previous, config, value, required, alerts, detail })
  }

  detail.local_hashps = value(facts, 'local_hashps', 'detail.local_hashps') ?? null
  detail.stratum_hashrate = value(facts, 'stratum_hashrate', 'detail.stratum_hashrate') ?? null

  for (const warning of facts.warnings instanceof Error ? [] : facts.warnings) notes.push(`node: ${warning}`)
  const blockValue = values.block_value instanceof Error ? null : values.block_value
  const blockPeriod = facts.block_period instanceof Error ? null : facts.block_period
  if (blockValue && blockValue.basis === 'projected') {
    notes.push('block value is projected: no live block template, subsidy only')
  }
  if (blockValue && typeof blockValue.age_sec === 'number' && typeof blockPeriod === 'number' && blockValue.age_sec > 3 * blockPeriod) {
    notes.push(`block template is ${blockValue.age_sec} s old, more than 3 block periods`)
  }
  if (typeof facts.topology_error === 'string') {
    notes.push(`api/node_topology unavailable (${facts.topology_error}); coin chain sync not checked`)
  }

  if (unavailable.length) {
    alerts.push('alert.data_unavailable')
    detail.unavailable = unavailable
  }
  detail.notes = notes.slice(0, MAX_NOTES)
  return { status: alerts.length ? 'DEGRADED' : 'OK', alerts, detail }
}

function localMinerRules ({ values, facts, previous, config, value, required, alerts, detail }) {
  const hashrate = required(values, 'hashrate', 'alert.hashrate_low')
  const online = value(values, 'workers_online', 'alert.no_recent_shares')
  const stalled = value(values, 'workers_stalled', 'alert.workers_stalled')
  const standby = value(values, 'workers_standby', 'detail.workers_standby')
  const scoped = required(facts, 'scoped', 'alert.no_recent_shares')

  detail.hashrate = hashrate ?? null
  detail.workers_online = online ?? null
  detail.workers_stalled = stalled ?? null
  detail.workers_standby = standby ?? null

  // alert.hashrate_low: below the floor on this poll and the previous one,
  // so one noisy vardiff sample does not flap it.
  if (config.hashrateFloor !== null && typeof hashrate === 'number') {
    const prev = previous && typeof previous.values.hashrate === 'number' ? previous.values.hashrate : null
    detail.previous_hashrate = prev
    if (hashrate < config.hashrateFloor && prev !== null && prev < config.hashrateFloor) {
      alerts.push('alert.hashrate_low')
    }
  }

  // alert.workers_stalled: a worker shared on this node, then went silent.
  if (Array.isArray(scoped)) {
    detail.stalled_workers = scoped.filter(w => w.state === 'stalled').map(w => w.name).slice(0, MAX_WORKER_ROWS)
  }
  if (typeof stalled === 'number' && stalled >= 1) alerts.push('alert.workers_stalled')

  // alert.no_recent_shares: rigs connected long enough, nothing accepted.
  if (Array.isArray(scoped)) {
    const connected = scoped.filter(w => w.connections > 0)
    detail.connections = sum(connected.map(w => w.connections))
    const thresholdS = config.noShareAlertMs / 1000
    if (connected.length > 0 && online === 0 && connected.every(w => w.connected_seconds >= thresholdS)) {
      alerts.push('alert.no_recent_shares')
    }
  }
}

/** Health when there is no usable snapshot: the poll failed or the config is invalid. */
function offline (err) {
  return { status: 'OFFLINE', alerts: ['alert.pool_unreachable'], detail: { error: errorCode(err) } }
}

/** True when the snapshot is older than STALE_POLLS poll intervals. */
function isStale (snapshot, config, now = Date.now()) {
  return now - snapshot.at > STALE_POLLS * config.pollIntervalMs
}

module.exports = { evaluate, offline, isStale }
