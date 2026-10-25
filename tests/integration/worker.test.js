'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const HyperswarmRPC = require('@hyperswarm/rpc')
const { WorkerRuntimeV2, protocol } = require('../../src/mdk')
const { createServer } = require('../../mock/server')
const { PKG_DIR, TYPE_OK, freePort } = require('../helpers')
const contract = require('../../mdk-contract.json')

const { ACTIONS, MESSAGE_TYPES, build, serialize, deserialize } = protocol

function tempDir (t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `c2pool-mdk-${name}-`))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('WorkerRuntimeV2 serves the c2pool contract and telemetry over HRPC', { timeout: 60000 }, async t => {
  const testnet = await createTestnet(3, t.teardown)
  const dash = await createServer({ port: 0, coin: 'dash' })
  const ltc = await createServer({ port: 0, coin: 'ltc' })
  t.teardown(() => dash.close())
  t.teardown(() => ltc.close())

  const caller = DHT.keyPair()
  const runtime = new WorkerRuntimeV2(PKG_DIR, {
    workerId: 'c2pool-test',
    storeDir: tempDir(t, 'store'),
    bootstrap: testnet.bootstrap,
    allowedKeys: [caller.publicKey],
    devices: [
      { deviceId: 'c2pool-dash', config: { nodeUrl: dash.nodeUrl, coin: 'DASH' } },
      { deviceId: 'c2pool-ltc', config: { nodeUrl: ltc.nodeUrl, coin: 'LTC', addresses: ['LEXAMPLE6xxxxxxxxxxxxxxxxxxxxxxxxx'] } }
    ]
  })
  await runtime.start()
  t.teardown(() => runtime.stop())

  const rpc = new HyperswarmRPC({ keyPair: caller, bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const send = async (fields) => {
    const envelope = build({ type: MESSAGE_TYPES.REQUEST, sender: 'kernel:kernel:test', ...fields })
    return deserialize(await rpc.request(runtime.getPublicKey(), 'mdk', serialize(envelope)))
  }
  const pull = (deviceId, query) => send({ action: ACTIONS.TELEMETRY_PULL, deviceId, payload: { query } })

  const identity = await send({ action: ACTIONS.IDENTITY_REQUEST })
  t.alike(identity.payload.devices, [{ deviceId: 'c2pool-dash' }, { deviceId: 'c2pool-ltc' }])

  const capability = await send({ action: ACTIONS.CAPABILITY_REQUEST })
  const published = capability.payload.contract
  t.is(published.metadata.deviceFamily, 'minerpool')
  t.alike(published.capabilities.telemetry.map(e => e.name), contract.capabilities.telemetry.map(e => e.name))
  t.ok(published.capabilities.telemetry.every(e => e.handler === undefined), 'handler paths never leave the worker')

  const { metrics } = (await pull('c2pool-dash', { type: 'metrics' })).payload
  for (const entry of contract.capabilities.telemetry) {
    t.ok(TYPE_OK[entry.type](metrics[entry.name]), `${entry.name} is a ${entry.type} over HRPC`)
  }
  t.is(metrics.workers_online, 25)
  t.is(metrics.health.status, 'OK')
  t.absent(JSON.stringify(metrics).includes('203.0.113'), 'no miner IP crosses the wire')

  t.is((await pull('c2pool-dash', { type: 'pending_payout' })).payload.value, 0.41095312, 'one channel by name')
  t.is((await pull('c2pool-dash', { type: 'health' })).payload.value.status, 'OK', 'health is the declared channel')
  t.ok(/ERR_UNKNOWN_QUERY_TYPE: balance/.test((await pull('c2pool-dash', { type: 'balance' })).payload.error), 'no balance channel')

  const ltcMetrics = (await pull('c2pool-ltc', { type: 'metrics' })).payload.metrics
  t.is(ltcMetrics.coin, 'LTC')
  t.is(ltcMetrics.pending_payout, 6.18919239)
  t.alike(ltcMetrics.pending_payout_merged, { DOGE: 9893.40760688 })
})

test('a channel error crosses the wire as its ERR_C2POOL_* code', { timeout: 60000 }, async t => {
  const testnet = await createTestnet(3, t.teardown)
  const caller = DHT.keyPair()
  const runtime = new WorkerRuntimeV2(PKG_DIR, {
    workerId: 'c2pool-down',
    bootstrap: testnet.bootstrap,
    allowedKeys: [caller.publicKey],
    devices: [{ deviceId: 'c2pool-down', config: { nodeUrl: `http://127.0.0.1:${await freePort()}`, timeoutMs: 2000 } }]
  })
  await runtime.start()
  t.teardown(() => runtime.stop())

  const rpc = new HyperswarmRPC({ keyPair: caller, bootstrap: testnet.bootstrap })
  t.teardown(() => rpc.destroy())
  const envelope = build({
    type: MESSAGE_TYPES.REQUEST,
    sender: 'kernel:kernel:test',
    action: ACTIONS.TELEMETRY_PULL,
    deviceId: 'c2pool-down',
    payload: { query: { type: 'metrics' } }
  })
  const { metrics } = deserialize(await rpc.request(runtime.getPublicKey(), 'mdk', serialize(envelope))).payload
  t.ok(/ERR_C2POOL_NODE_UNREACHABLE \/local_stats/.test(metrics.hashrate.error), 'no fabricated zero')
  t.alike(metrics.health, { status: 'OFFLINE', alerts: ['alert.pool_unreachable'], detail: { error: 'ERR_C2POOL_NODE_UNREACHABLE' } })
})

test('the runtime refuses to start without an allow-list (MDK v0.12 is fail-closed)', async t => {
  const runtime = new WorkerRuntimeV2(PKG_DIR, {
    workerId: 'c2pool-open',
    devices: [{ deviceId: 'c2pool-0', config: {} }]
  })
  await t.exception(runtime.start(), /ERR_WORKER_ALLOWED_KEYS_REQUIRED/)
})
