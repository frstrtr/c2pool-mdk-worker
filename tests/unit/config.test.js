'use strict'

const test = require('brittle')
const { parseConfig, canonicalCoin } = require('../../src/config')

test('defaults', t => {
  t.alike(parseConfig({}), {
    nodeUrl: 'http://127.0.0.1:8080',
    coin: null,
    addresses: [],
    hashrateFloor: null,
    pollIntervalMs: 30000,
    timeoutMs: 10000,
    noShareAlertMs: 900000,
    recentBlocks: 50
  })
  t.ok(Object.isFrozen(parseConfig({})))
  t.ok(Object.isFrozen(parseConfig({}).addresses))
})

test('accepted values are normalized', t => {
  const config = parseConfig({
    nodeUrl: 'https://pool.example.org/c2pool/',
    coin: 'ltc',
    addresses: ['LEXAMPLE6xxxxxxxxxxxxxxxxxxxxxxxxx', 'ltc1qexample10qqqqqqqqqqqqqqqqqqqqqqqqqqqqq'],
    hashrateFloor: 0,
    pollIntervalMs: 5000,
    recentBlocks: 1000
  })
  t.is(config.nodeUrl, 'https://pool.example.org/c2pool')
  t.is(config.coin, 'LTC')
  t.is(config.addresses.length, 2)
  t.is(config.hashrateFloor, 0)
})

test('the coin must be one the worker supports; BIP110 is reported, not configured', t => {
  for (const coin of ['BTC', 'btc', 'LTC', 'Dash']) t.ok(parseConfig({ coin }).coin)
  for (const coin of ['BIP110', 'DOGE', 'ZEC', '', 1]) {
    t.exception(() => parseConfig({ coin }), /ERR_C2POOL_CONFIG_INVALID coin/, String(coin))
  }
  t.is(canonicalCoin('BIP110'), 'BTC')
  t.is(canonicalCoin('ltc'), 'LTC')
})

test('addresses: non-empty, unique, plain strings', t => {
  const bad = [
    'bc1q...',
    [''],
    ['A', 'A'],
    ['A.worker'],
    ['A,B'],
    ['A B'],
    ['A+512'],
    [42],
    ['x'.repeat(129)]
  ]
  for (const addresses of bad) {
    t.exception(() => parseConfig({ addresses }), /ERR_C2POOL_ADDRESS_INVALID/, JSON.stringify(addresses).slice(0, 40))
  }
})

test('numeric options are range-checked', t => {
  const bad = {
    hashrateFloor: [-1, '1e12', NaN],
    pollIntervalMs: [4999, 0, '30000'],
    timeoutMs: [0, -5, Infinity],
    noShareAlertMs: [0, null],
    recentBlocks: [0, 1.5, 1001, '50']
  }
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) {
      t.exception(() => parseConfig({ [key]: value }), new RegExp(`ERR_C2POOL_CONFIG_INVALID ${key}`), `${key}=${value}`)
    }
  }
})

test('an unknown key is an error, so a typo cannot fall back to the default node', t => {
  t.exception(() => parseConfig({ nodeURL: 'http://192.0.2.1:8080' }), /ERR_C2POOL_CONFIG_INVALID unknown key nodeURL/)
  t.exception(() => parseConfig(null), /ERR_C2POOL_CONFIG_INVALID config/)
  t.exception(() => parseConfig([]), /ERR_C2POOL_CONFIG_INVALID config/)
})

test('nodeUrl must be a plain http(s) URL', t => {
  for (const nodeUrl of ['ftp://h', 'http://u:p@h:8080', 'http://h:8080/?x=1', 'http://h:8080/#a', 'http://h/control', 'nope', '', 8080]) {
    t.exception(() => parseConfig({ nodeUrl }), /ERR_C2POOL_NODE_URL_INVALID/, String(nodeUrl))
  }
})
