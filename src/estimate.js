'use strict'

const { DataError } = require('./errors')
const { TWO_POW_32, DAY_S } = require('./constants')

/**
 * Expected blocks per day for the whole pool, a Poisson rate:
 *   H_pool × 86400 / (D × 2^32)
 * @param {number} poolHps    global_stats.pool_hash_rate, H/s
 * @param {number} difficulty global_stats.network_block_difficulty
 */
function expectedBlocksPerDay (poolHps, difficulty) {
  if (!(typeof poolHps === 'number' && Number.isFinite(poolHps) && poolHps > 0)) {
    throw new DataError('global_stats.pool_hash_rate')
  }
  if (!(typeof difficulty === 'number' && Number.isFinite(difficulty) && difficulty > 0)) {
    throw new DataError('global_stats.network_block_difficulty')
  }
  return poolHps * DAY_S / (difficulty * TWO_POW_32)
}

/**
 * Expected coins per day: blocks per day × the scope's coinbase share at the
 * current template. An expectation, not a settlement.
 */
function estimatedEarnings (blocksPerDay, payout) {
  return blocksPerDay * payout
}

/**
 * Network hashrate from difficulty and the coin's target block period.
 * The node's own global_stats.network_hashrate assumes a 150 s period on
 * every coin, which overstates BTC four times, so it is never used.
 */
function networkHashrate (difficulty, blockPeriod) {
  if (!(typeof difficulty === 'number' && Number.isFinite(difficulty) && difficulty > 0)) {
    throw new DataError('global_stats.network_block_difficulty')
  }
  if (!(typeof blockPeriod === 'number' && Number.isFinite(blockPeriod) && blockPeriod > 0)) {
    throw new DataError('web/currency_info.block_period')
  }
  return difficulty * TWO_POW_32 / blockPeriod
}

module.exports = { expectedBlocksPerDay, estimatedEarnings, networkHashrate }
