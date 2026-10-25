'use strict'

const test = require('brittle')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const createTestnet = require('hyperdht/testnet')
const DHT = require('hyperdht')
const mdk = require('../../src/mdk')
const { createServer } = require('../../mock/server')
const { PKG_DIR, TYPE_OK } = require('../helpers')
const contract = require('../../mdk-contract.json')

test('a real Kernel takes the worker to READY and serves its telemetry to a client', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c2pool-kernel-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const testnet = await createTestnet(3, t.teardown)
  const server = await createServer({ port: 0, coin: 'dash' })
  t.teardown(() => server.close())

  const { getKernel, waitForDiscovery, shutdown } = mdk.kernel
  const kernel = await getKernel({
    root,
    keyFile: false,
    discovery: { mode: 'local' },
    hrpc: { bootstrap: testnet.bootstrap }
  })
  t.teardown(() => shutdown(kernel))

  // v0.12 is fail-closed both ways: the worker admits the Kernel's client
  // key, and the Kernel admits this test's caller key read-only.
  const runtime = new mdk.WorkerRuntimeV2(PKG_DIR, {
    workerId: 'c2pool-kernel-test',
    storeDir: path.join(root, 'worker'),
    bootstrap: testnet.bootstrap,
    allowedKeys: [kernel.getClientPublicKey()],
    devices: [{ deviceId: 'c2pool-0', config: { nodeUrl: server.nodeUrl } }]
  })
  await runtime.start()
  t.teardown(() => runtime.stop())

  await kernel.registerWorker(runtime.getPublicKey())
  const workers = await waitForDiscovery(kernel, { minWorkers: 1, timeoutMs: 30000 })
  const worker = workers.find(w => w.workerId === 'c2pool-kernel-test')
  t.is(worker && worker.state, 'READY')
  t.alike(worker && worker.deviceIds, ['c2pool-0'])

  const caller = DHT.keyPair()
  kernel.allowKey(caller.publicKey, ['read'])
  const client = mdk.client.createMdkClient({
    kernelKey: kernel.getPublicKey(),
    kernelKeyPair: caller,
    kernelBootstrap: testnet.bootstrap
  })
  t.teardown(() => client.close())
  await client.connect()

  const { metrics } = await client.pullTelemetry('c2pool-0', 'metrics')
  for (const entry of contract.capabilities.telemetry) {
    t.ok(TYPE_OK[entry.type](metrics[entry.name]), `${entry.name} is a ${entry.type} through the Kernel`)
  }
  t.is(metrics.coin, 'DASH')
  t.is(metrics.pending_payout, 0.41095312)
  t.is(metrics.health.status, 'OK')
  t.absent(JSON.stringify(metrics).includes('203.0.113'), 'no miner IP leaves the worker')
})
