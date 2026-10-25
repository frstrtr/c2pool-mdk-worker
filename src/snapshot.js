'use strict'

const { DataError, ConfigError, hasCode, errorCode } = require('./errors')
const { canonicalCoin } = require('./config')
const { normalizeWorkers } = require('./workers')
const { scopeAddresses, inScope } = require('./scope')
const { expectedBlocksPerDay, estimatedEarnings, networkHashrate } = require('./estimate')
const {
  toNumber, toOptionalNumber, toBoolean, toOptionalString, sum, roundCoins
} = require('./utils/numbers')
const { IDENTITY_TTL_MS, DAY_S, MAX_WORKER_ROWS, MAX_WARNINGS } = require('./constants')

/**
 * One poll of the node: fetch every response the channels need and turn
 * them into a snapshot. See fetchResponses and buildSnapshot.
 * @param {{ get: (path: string) => Promise<unknown> }} api
 * @param {object} config parseConfig() output
 * @param {{ now?: number, identity?: object|null }} [options] identity = the last one, reused for an hour
 */
async function poll (api, config, { now = Date.now(), identity = null } = {}) {
  const responses = await fetchResponses(api, config, { now, identity })
  return buildSnapshot(responses, config, { now })
}

/**
 * /local_stats goes first and alone: when the node is down, that is the one
 * request that fails. The rest go in parallel and each is required, except
 * /api/node_topology (absent on some builds). The node identity is fetched
 * on the first poll and then once an hour.
 */
async function fetchResponses (api, config, { now = Date.now(), identity = null } = {}) {
  const localStats = await api.get('/local_stats')
  const stale = !identity || now - identity.fetchedAt >= IDENTITY_TTL_MS

  const [stratumStats, globalStats, pplns, recentBlocks, syncStatus, topology, freshIdentity] = await Promise.all([
    api.get('/stratum_stats'),
    api.get('/global_stats'),
    api.get('/pplns/current'),
    api.get('/recent_blocks'),
    api.get('/web/sync_status'),
    api.get('/api/node_topology').then(body => ({ body }), err => ({ error: errorCode(err) })),
    stale ? fetchIdentity(api, now) : identity
  ])

  return { identity: freshIdentity, localStats, stratumStats, globalStats, pplns, recentBlocks, syncStatus, topology }
}

async function fetchIdentity (api, now) {
  const [nodeInfo, currencyInfo] = await Promise.all([api.get('/node_info'), api.get('/web/currency_info')])
  return parseIdentity(nodeInfo, currencyInfo, now)
}

/**
 * Who the node says it is. external_ip is not kept.
 */
function parseIdentity (nodeInfo, currencyInfo, now = Date.now()) {
  const ni = expectObject('/node_info', nodeInfo)
  const ci = expectObject('/web/currency_info', currencyInfo)
  if (typeof ni.symbol !== 'string' || ni.symbol.length === 0) throw new DataError('node_info.symbol')
  const coins = Array.isArray(ci.coins) ? ci.coins : []
  return Object.freeze({
    symbol: ni.symbol,
    coin: canonicalCoin(ni.symbol),
    network: str(ni.network),
    version: str(ni.version),
    worker_port: num(ni.worker_port),
    p2p_port: num(ni.p2p_port),
    name: str(ci.name),
    block_period: num(ci.block_period),
    share_version: num(ci.share_version),
    merged: Object.freeze(coins.filter(c => c && c.merged === true && typeof c.symbol === 'string').map(c => c.symbol)),
    fetchedAt: now
  })
}

/**
 * Turn one set of responses into a snapshot. Pure: the same responses,
 * config and `now` give the same snapshot.
 *
 * Every channel value is computed here once. A channel whose inputs are
 * missing or malformed holds the ERR_C2POOL_* error instead of a value, so
 * one bad field fails that channel only; it never turns into a zero.
 *
 * @returns {{ at: number, identity: object, values: object, facts: object }}
 */
function buildSnapshot (responses, config, { now = Date.now() } = {}) {
  const identity = responses.identity
  if (config.coin && identity.coin !== config.coin) {
    throw new ConfigError('ERR_C2POOL_COIN_MISMATCH', `node reports ${identity.symbol.slice(0, 16)}`)
  }

  const ls = expectObject('/local_stats', responses.localStats)
  const ss = expectObject('/stratum_stats', responses.stratumStats)
  const gs = expectObject('/global_stats', responses.globalStats)
  const pp = expectObject('/pplns/current', responses.pplns)
  const blocks = expectArray('/recent_blocks', responses.recentBlocks).slice(0, config.recentBlocks)
  const sync = expectObject('/web/sync_status', responses.syncStatus)
  const topology = responses.topology || { error: 'ERR_C2POOL_DATA' }

  const c = lazy({
    role: () => toOptionalString(ls.node_role, 'local_stats.node_role'),
    relay: () => c.role === 'relay',
    workers: () => normalizeWorkers(ss.workers),
    scope: () => scopeAddresses(c.workers.rows, config),
    scoped: () => c.workers.rows.filter(w => inScope(w.address, c.scope)),
    miners: () => parseMiners(pp),
    scopedMiners: () => c.miners.filter(m => inScope(m.address, c.scope)),
    payout: () => roundCoins(sum(c.scopedMiners.map(m => m.amount))),
    poolHps: () => toNumber(gs.pool_hash_rate, 'global_stats.pool_hash_rate'),
    difficulty: () => toNumber(gs.network_block_difficulty, 'global_stats.network_block_difficulty'),
    blocksPerDay: () => expectedBlocksPerDay(c.poolHps, c.difficulty),
    peers: () => {
      const p = expectObject('local_stats.peers', ls.peers)
      return {
        incoming: toNumber(p.incoming, 'local_stats.peers.incoming'),
        outgoing: toNumber(p.outgoing, 'local_stats.peers.outgoing')
      }
    },
    stale: () => {
      const p = expectObject('local_stats.my_stale_proportions_in_last_hour', ls.my_stale_proportions_in_last_hour)
      const field = (key) => `local_stats.my_stale_proportions_in_last_hour.${key}`
      return {
        stale: toNumber(p.stale, field('stale')),
        orphan: toNumber(p.orphan_stale, field('orphan_stale')),
        doa: toNumber(p.dead_stale, field('dead_stale'))
      }
    },
    ready: () => toBoolean(sync.ready, 'web/sync_status.ready'),
    coinChain: () => (topology.body ? coinChain(topology.body, identity) : null),
    warnings: () => {
      if (ls.warnings === undefined || ls.warnings === null) return []
      if (!Array.isArray(ls.warnings)) throw new DataError('local_stats.warnings')
      return ls.warnings.filter(w => typeof w === 'string').slice(0, MAX_WARNINGS)
    }
  })

  const mining = () => {
    if (c.relay) throw new Error('ERR_C2POOL_RELAY_NODE')
    return c.scoped
  }
  const countState = (state) => mining().filter(w => w.state === state).length
  // A node that is not ready (no verified shares or no work template) has no
  // trustworthy PPLNS projection; its payout channels fail instead of reading 0.
  const settled = () => {
    if (c.ready === false) throw new Error('ERR_C2POOL_NOT_READY')
    return c.scopedMiners
  }

  const values = capture({
    hashrate: () => sum(mining().map(w => w.hashrate)),
    hashrate_dead: () => sum(mining().map(w => w.hashrate_dead)),
    workers_online: () => countState('hashing'),
    workers_stalled: () => countState('stalled'),
    workers_standby: () => countState('standby'),
    workers: () => mining().slice(0, MAX_WORKER_ROWS),
    pplns_share: () => sum(settled().map(m => m.pct)),
    pending_payout: () => {
      settled()
      return c.payout
    },
    pending_payout_merged: () => mergedPayout(pp, settled()),
    estimated_earnings: () => {
      settled()
      return estimatedEarnings(c.blocksPerDay, c.payout)
    },
    expected_blocks_per_day: () => c.blocksPerDay,
    pool_hashrate: () => c.poolHps,
    network_difficulty: () => c.difficulty,
    network_hashrate: () => networkHashrate(c.difficulty, identity.block_period),
    block_value: () => blockValue(ls),
    blocks_found_24h: () => blocksFound24h(blocks, now),
    last_block_found: () => (blocks.length ? lastBlock(blocks[0]) : null),
    share_difficulty: () => {
      if (gs.min_difficulty === null || gs.min_difficulty === undefined) throw new DataError('global_stats.min_difficulty')
      return toNumber(gs.min_difficulty, 'global_stats.min_difficulty')
    },
    stale_rate: () => c.stale.stale,
    efficiency: () => {
      if (ls.efficiency === null || ls.efficiency === undefined) throw new DataError('local_stats.efficiency')
      return toNumber(ls.efficiency, 'local_stats.efficiency')
    },
    sharechain: () => sharechain(c, { ls, gs, pp, sync, identity }),
    peers: () => c.peers.incoming + c.peers.outgoing,
    coin: () => identity.symbol,
    node: () => ({
      version: toOptionalString(ls.version, 'local_stats.version') ?? identity.version,
      protocol_version: toOptionalNumber(ls.protocol_version, 'local_stats.protocol_version'),
      role: c.role,
      uptime_s: toOptionalNumber(ls.uptime, 'local_stats.uptime'),
      network: identity.network,
      worker_port: identity.worker_port,
      warnings: c.warnings
    })
  })

  // What health.evaluate needs beyond the channel values.
  const facts = capture({
    relay: () => c.relay,
    scoped: () => c.scoped,
    peers: () => c.peers.incoming + c.peers.outgoing,
    coin_p2p_state: () => {
      if (ls.coin_p2p === undefined || ls.coin_p2p === null) return null
      const p2p = expectObject('local_stats.coin_p2p', ls.coin_p2p)
      if (typeof p2p.state !== 'string') throw new DataError('local_stats.coin_p2p.state')
      return p2p.state
    },
    sync_ready: () => c.ready,
    coin_chain_synced: () => c.coinChain?.synced ?? null,
    local_hashps: () => toOptionalNumber(ls.local_hashps, 'local_stats.local_hashps'),
    stratum_hashrate: () => c.workers.gross,
    warnings: () => c.warnings,
    block_period: () => identity.block_period,
    topology_error: () => topology.error || null
  })

  return deepFreeze({ at: now, identity, values, facts })
}

/** A channel's value, or its error rethrown. */
function read (snapshot, name) {
  if (!Object.hasOwn(snapshot.values, name)) throw new Error(`ERR_C2POOL_UNKNOWN_CHANNEL ${name}`)
  const value = snapshot.values[name]
  if (value instanceof Error) throw value
  return value
}

function parseMiners (pp) {
  if (!Array.isArray(pp.miners)) throw new DataError('pplns/current.miners')
  return pp.miners.map(m => {
    if (!m || typeof m !== 'object' || typeof m.address !== 'string') {
      throw new DataError('pplns/current.miners[].address')
    }
    const merged = m.merged === undefined || m.merged === null ? [] : m.merged
    if (!Array.isArray(merged)) throw new DataError('pplns/current.miners[].merged')
    return {
      address: m.address,
      amount: toNumber(m.amount, 'pplns/current.miners[].amount'),
      pct: toNumber(m.pct, 'pplns/current.miners[].pct'),
      merged: merged.map(x => {
        if (!x || typeof x !== 'object' || typeof x.symbol !== 'string') {
          throw new DataError('pplns/current.miners[].merged[].symbol')
        }
        return { symbol: x.symbol, amount: toNumber(x.amount, 'pplns/current.miners[].merged[].amount') }
      })
    }
  })
}

function mergedPayout (pp, scopedMiners) {
  const chains = pp.merged_chains === undefined || pp.merged_chains === null ? [] : pp.merged_chains
  if (!Array.isArray(chains) || chains.some(s => typeof s !== 'string')) {
    throw new DataError('pplns/current.merged_chains')
  }
  const totals = {}
  for (const symbol of chains) totals[symbol] = 0
  for (const miner of scopedMiners) {
    for (const entry of miner.merged) totals[entry.symbol] = (totals[entry.symbol] || 0) + entry.amount
  }
  for (const symbol of Object.keys(totals)) totals[symbol] = roundCoins(totals[symbol])
  return totals
}

function blockValue (ls) {
  const field = (key) => `local_stats.${key}`
  const coins = (key, value = ls[key]) => roundCoins(toNumber(value, field(key)))
  return {
    total: coins('block_value'),
    miner_net: coins('block_value_miner_net', ls.block_value_miner_net ?? ls.block_value_miner),
    miner_gross: coins('block_value_miner_gross'),
    fee: coins('block_value_fee'),
    payments: coins('block_value_payments'),
    basis: toOptionalString(ls.block_value_basis, field('block_value_basis')),
    height: toOptionalNumber(ls.block_value_height, field('block_value_height')),
    age_sec: toOptionalNumber(ls.block_value_age_sec, field('block_value_age_sec')),
    fee_percent: toNumber(ls.fee_percent, field('fee_percent'))
  }
}

function blocksFound24h (blocks, now) {
  const cutoff = now / 1000 - DAY_S
  let count = 0
  for (const row of blocks) {
    if (!row || typeof row !== 'object') throw new DataError('recent_blocks[]')
    const ts = toNumber(row.ts, 'recent_blocks[].ts')
    if (ts >= cutoff && row.status !== 'orphaned') count++
  }
  return count
}

function lastBlock (row) {
  if (!row || typeof row !== 'object') throw new DataError('recent_blocks[]')
  const field = (key) => `recent_blocks[0].${key}`
  return {
    height: toOptionalNumber(row.height, field('height')),
    hash: toOptionalString(row.hash, field('hash')),
    ts: toOptionalNumber(row.ts, field('ts')),
    found_by: toOptionalString(row.found_by, field('found_by')),
    status: toOptionalString(row.status, field('status')),
    confirmations: toOptionalNumber(row.confirmations, field('confirmations')),
    block_reward: toOptionalNumber(row.block_reward, field('block_reward')),
    explorer_url: toOptionalString(row.explorer_url, field('explorer_url'))
  }
}

function sharechain (c, { ls, gs, pp, sync, identity }) {
  const out = {
    synced: c.ready,
    height: toNumber(gs.current_height, 'global_stats.current_height'),
    shares_in_window: toNumber(gs.shares_in_chain, 'global_stats.shares_in_chain'),
    window_size: toNumber(pp.window_size, 'pplns/current.window_size'),
    verified: toNumber(sync.verified_size, 'web/sync_status.verified_size'),
    peers_in: c.peers.incoming,
    peers_out: c.peers.outgoing,
    unique_miners: toNumber(gs.unique_miners, 'global_stats.unique_miners'),
    orphan_rate: c.stale.orphan,
    doa_rate: c.stale.doa
  }
  // local_shares exists on the DASH build only.
  if (ls.local_shares && typeof ls.local_shares === 'object' && ls.local_shares.orphan_rate !== undefined) {
    out.local_orphan_rate = toNumber(ls.local_shares.orphan_rate, 'local_stats.local_shares.orphan_rate')
  }
  out.protocol_version = toOptionalNumber(ls.protocol_version, 'local_stats.protocol_version')
  out.share_version = identity.share_version
  if (c.coinChain) out.coin_chain = c.coinChain
  return out
}

/**
 * The primary coin's header-follower state from /api/node_topology. The
 * endpoint is diagnostic and differs between builds, so an absent or
 * mistyped field is null rather than an error.
 */
function coinChain (body, identity) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.coins)) return null
  const coins = body.coins.filter(x => x && typeof x === 'object')
  const primary = coins.find(x => x.primary === true) || coins.find(x => x.coin === identity.symbol)
  if (!primary) return null
  return {
    synced: typeof primary.synced === 'boolean' ? primary.synced : null,
    sync_percent: num(primary.sync_percent),
    height: num(primary.header_height ?? primary.height),
    target_height: num(primary.target_height),
    peers: num(primary.peers)
  }
}

function expectObject (path, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DataError(path)
  return body
}

function expectArray (path, body) {
  if (!Array.isArray(body)) throw new DataError(path)
  return body
}

function str (value) {
  return typeof value === 'string' ? value : null
}

function num (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Getters that compute once on first read and cache the value or the error.
 * A definition may read other keys of the same object.
 */
function lazy (defs) {
  const out = {}
  for (const [key, fn] of Object.entries(defs)) {
    let state = null
    Object.defineProperty(out, key, {
      enumerable: true,
      get () {
        if (!state) {
          try {
            state = { value: fn() }
          } catch (error) {
            state = { error }
          }
        }
        if (state.error) throw state.error
        return state.value
      }
    })
  }
  return out
}

/**
 * Run each function; keep its value, or its error when the error carries a
 * stable ERR_* code. Anything else is a bug and fails the poll.
 */
function capture (table) {
  const out = {}
  for (const [name, fn] of Object.entries(table)) {
    try {
      out[name] = fn()
    } catch (err) {
      if (!hasCode(err)) throw err
      out[name] = err
    }
  }
  return out
}

function deepFreeze (value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

module.exports = { poll, fetchResponses, parseIdentity, buildSnapshot, read }
