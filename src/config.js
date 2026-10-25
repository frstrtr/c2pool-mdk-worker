'use strict'

const { ConfigError } = require('./errors')
const { parseNodeUrl } = require('./api/client')
const { DEFAULTS, MIN_POLL_INTERVAL_MS, MAX_RECENT_BLOCKS, SUPPORTED_COINS, COIN_ALIASES } = require('./constants')

const KEYS = Object.keys(DEFAULTS)
// Payout addresses are base58 or bech32 (or another coin's plain token);
// none of them contain whitespace or the stratum separators . , + /
const ADDRESS = /^[^\s.,+/]{1,128}$/

/**
 * Validate a device's config (the ambient `opts`) and fill in defaults.
 * Throws a ConfigError naming the bad key; an unknown key is an error too,
 * so a typo such as `nodeURL` cannot silently fall back to the default node.
 * @param {object} [opts]
 * @returns {Readonly<object>}
 */
function parseConfig (opts = {}) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', 'config')
  }
  for (const key of Object.keys(opts)) {
    if (!KEYS.includes(key)) throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', `unknown key ${key.slice(0, 64)}`)
  }
  const pick = (key) => (opts[key] === undefined ? DEFAULTS[key] : opts[key])

  const nodeUrl = parseNodeUrl(pick('nodeUrl'))

  let coin = pick('coin')
  if (coin !== null) {
    if (typeof coin !== 'string' || !SUPPORTED_COINS.includes(coin.toUpperCase())) {
      throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', 'coin')
    }
    coin = coin.toUpperCase()
  }

  const addresses = pick('addresses')
  if (!Array.isArray(addresses)) throw new ConfigError('ERR_C2POOL_ADDRESS_INVALID')
  const seen = new Set()
  for (const address of addresses) {
    if (typeof address !== 'string' || !ADDRESS.test(address) || seen.has(address)) {
      throw new ConfigError('ERR_C2POOL_ADDRESS_INVALID')
    }
    seen.add(address)
  }

  const hashrateFloor = pick('hashrateFloor')
  if (hashrateFloor !== null && !isNumber(hashrateFloor, 0)) {
    throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', 'hashrateFloor')
  }

  const pollIntervalMs = number(pick('pollIntervalMs'), 'pollIntervalMs', MIN_POLL_INTERVAL_MS)
  const timeoutMs = number(pick('timeoutMs'), 'timeoutMs', 1)
  const noShareAlertMs = number(pick('noShareAlertMs'), 'noShareAlertMs', 1)
  const recentBlocks = pick('recentBlocks')
  if (!Number.isInteger(recentBlocks) || recentBlocks < 1 || recentBlocks > MAX_RECENT_BLOCKS) {
    throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', 'recentBlocks')
  }

  return Object.freeze({
    nodeUrl,
    coin,
    addresses: Object.freeze([...addresses]),
    hashrateFloor,
    pollIntervalMs,
    timeoutMs,
    noShareAlertMs,
    recentBlocks
  })
}

/** The coin a node symbol stands for: BIP110 is a Bitcoin lane. */
function canonicalCoin (symbol) {
  const upper = String(symbol).toUpperCase()
  return COIN_ALIASES[upper] || upper
}

function isNumber (value, min) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
}

function number (value, key, min) {
  if (!isNumber(value, min)) throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', key)
  return value
}

module.exports = { parseConfig, canonicalCoin }
