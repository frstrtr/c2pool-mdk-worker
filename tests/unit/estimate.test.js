'use strict'

const test = require('brittle')
const { expectedBlocksPerDay, estimatedEarnings, networkHashrate } = require('../../src/estimate')
const { near } = require('../helpers')

test('DASH worked example: 4.54 blocks/day, 1.87 DASH/day', t => {
  const blocks = expectedBlocksPerDay(34976790374428, 154979336.73131877)
  t.ok(near(blocks, 4.54, 0.005))
  t.ok(near(estimatedEarnings(blocks, 0.41095312), 1.866, 0.001))
})

test('LTC worked example: 0.0381 blocks/day, 0.236 LTC/day, 377 DOGE/day', t => {
  const blocks = expectedBlocksPerDay(173825432605, 91737839.63838163)
  t.ok(near(blocks, 0.0381, 0.0001), 'one block per ~26 days')
  t.ok(near(1 / blocks, 26.2, 0.1))
  t.ok(near(estimatedEarnings(blocks, 6.18919239), 0.236, 0.001))
  t.ok(near(estimatedEarnings(blocks, 9893.40760688), 377, 1))
})

test('BTC worked example: 1.09e-6 blocks/day, 3.4e-6 BTC/day', t => {
  const blocks = expectedBlocksPerDay(321683760, 5943717411.5921955)
  t.ok(near(blocks, 1.09e-6, 0.01e-6))
  t.ok(near(estimatedEarnings(blocks, 3.12185282), 3.4e-6, 0.01e-6))
})

test('network hashrate uses the coin block period', t => {
  const d = 5943717411.5921955
  t.is(networkHashrate(d, 600), d * 4294967296 / 600)
  t.is(networkHashrate(d, 150) / networkHashrate(d, 600), 4, 'a 150 s assumption is 4x too high on BTC')
})

test('missing or zero inputs are errors, never a zero estimate', t => {
  t.exception(() => expectedBlocksPerDay(0, 1e8), /ERR_C2POOL_DATA global_stats.pool_hash_rate/)
  t.exception(() => expectedBlocksPerDay(null, 1e8), /ERR_C2POOL_DATA global_stats.pool_hash_rate/)
  t.exception(() => expectedBlocksPerDay(1e12, 0), /ERR_C2POOL_DATA global_stats.network_block_difficulty/)
  t.exception(() => expectedBlocksPerDay(1e12, null), /ERR_C2POOL_DATA global_stats.network_block_difficulty/)
  t.exception(() => networkHashrate(1e8, null), /ERR_C2POOL_DATA web\/currency_info.block_period/)
  t.exception(() => networkHashrate(0, 600), /ERR_C2POOL_DATA global_stats.network_block_difficulty/)
})
