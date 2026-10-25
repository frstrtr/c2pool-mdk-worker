'use strict'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

const DEFAULT_NODE_URL = 'http://127.0.0.1:8080'
// c2pool marks a connection silent after max(900 s, 6 share intervals at its vardiff).
const SILENT_FLOOR_S = 900

module.exports = {
  DEFAULT_NODE_URL,

  // The only paths the client will request, all GET. /control/* is not here
  // and never will be: the worker is read-only.
  PATHS: Object.freeze([
    '/node_info',
    '/web/currency_info',
    '/local_stats',
    '/stratum_stats',
    '/global_stats',
    '/pplns/current',
    '/recent_blocks',
    '/web/sync_status',
    '/api/node_topology'
  ]),

  DEFAULTS: Object.freeze({
    nodeUrl: DEFAULT_NODE_URL,
    coin: null,
    addresses: Object.freeze([]),
    hashrateFloor: null,
    // A metrics pull reads 25 channels; all of them share one poll for this long.
    pollIntervalMs: 30 * SECOND_MS,
    timeoutMs: 10 * SECOND_MS,
    // Rigs connected this long with nothing accepted raise alert.no_recent_shares.
    noShareAlertMs: SILENT_FLOOR_S * SECOND_MS,
    recentBlocks: 50
  }),
  MIN_POLL_INTERVAL_MS: 5 * SECOND_MS,
  MAX_RECENT_BLOCKS: 1000,

  // /node_info and /web/currency_info change only on a node restart.
  IDENTITY_TTL_MS: HOUR_MS,
  // A failed poll is rethrown by every channel for this long, so a down node
  // costs one request (and at most one timeout) per pull, not one per channel.
  ERROR_CACHE_MS: 10 * SECOND_MS,
  // health reports OFFLINE when the newest snapshot is older than this many poll intervals.
  STALE_POLLS: 3,

  // Hashes per unit of difficulty for BTC, LTC, DASH and DOGE (and c2pool's attempts_to_block).
  TWO_POW_32: 4294967296,
  DAY_S: 86400,
  SILENT_FLOOR_S,

  SUPPORTED_COINS: Object.freeze(['BTC', 'LTC', 'DASH']),
  // The BIP-110 lane is a Bitcoin node that reports its own symbol.
  COIN_ALIASES: Object.freeze({ BIP110: 'BTC' }),

  WORKER_STATES: Object.freeze(['hashing', 'standby', 'stalled']),
  MAX_WORKER_ROWS: 1000,
  MAX_WARNINGS: 20,
  MAX_NOTES: 40
}
