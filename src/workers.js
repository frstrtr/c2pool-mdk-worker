'use strict'

const { DataError } = require('./errors')
const { parseUsername } = require('./scope')
const { toNumber, toOptionalNumber, toBoolean } = require('./utils/numbers')
const { WORKER_STATES } = require('./constants')

/**
 * Normalize /stratum_stats `workers` (keyed by full stratum username) into
 * rows sorted by name. Only the fields below leave this function; the
 * node's remote_endpoint, rtt and first/last-seen are dropped here.
 *
 * Builds differ: newer ones report `state` and `last_share_age_s` per
 * worker, older ones do not. Missing keys are derived exactly as the node
 * derives them (see deriveState), never guessed from the version string.
 *
 * @param {unknown} workers stratum_stats.workers
 * @returns {{ rows: object[], gross: number }} gross = Σ hash_rate including dead work
 */
function normalizeWorkers (workers) {
  if (!workers || typeof workers !== 'object' || Array.isArray(workers)) {
    throw new DataError('stratum_stats.workers')
  }

  const rows = []
  let gross = 0
  for (const [name, w] of Object.entries(workers)) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new DataError('stratum_stats.workers[]')
    const field = (key) => `stratum_stats.workers[].${key}`

    const hashRate = toNumber(w.hash_rate, field('hash_rate'))
    const dead = toNumber(w.dead_hash_rate, field('dead_hash_rate'))
    const accepted = toNumber(w.accepted, field('accepted'))
    const silent = toBoolean(w.silent, field('silent'))
    const silentSeconds = toOptionalNumber(w.silent_seconds, field('silent_seconds'))
    const user = parseUsername(name)
    gross += hashRate

    rows.push({
      name,
      address: user.primary,
      worker: user.worker,
      hashrate: Math.max(0, hashRate - dead),
      hashrate_dead: dead,
      difficulty: toNumber(w.difficulty, field('difficulty')),
      connections: toNumber(w.connections, field('connections')),
      accepted,
      rejected: toNumber(w.rejected, field('rejected')),
      stale: toNumber(w.stale, field('stale')),
      state: WORKER_STATES.includes(w.state) ? w.state : deriveState(accepted, silent),
      last_share_age_s: w.last_share_age_s !== undefined
        ? toOptionalNumber(w.last_share_age_s, field('last_share_age_s'))
        : (accepted > 0 ? silentSeconds : null),
      connected_seconds: toNumber(w.connected_seconds, field('connected_seconds'))
    })
  }

  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { rows, gross }
}

/**
 * The node's own liveness rule (web_server.hpp WorkerLiveness):
 *   hashing = has shared on this node and is not silent
 *   stalled = has shared, then went silent
 *   standby = authorized, never shared here (a failover connection, not a fault)
 */
function deriveState (accepted, silent) {
  if (accepted > 0) return silent ? 'stalled' : 'hashing'
  return 'standby'
}

module.exports = { normalizeWorkers, deriveState }
