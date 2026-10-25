'use strict'

// Start the mock node and print every channel the worker reports for it.
//
//   node examples/mock.js [dash|ltc|btc]

const path = require('node:path')
const { loadContract, createInstance } = require('../src/mdk')
const { createServer } = require('../mock/server')

const PKG_DIR = path.join(__dirname, '..')

async function main () {
  const coin = process.argv[2] || 'dash'
  const mock = await createServer({ port: 0, coin })
  try {
    const { entries } = loadContract(PKG_DIR)
    const instance = createInstance({
      dir: PKG_DIR,
      entries,
      device: { id: 'c2pool-example', opts: { nodeUrl: mock.nodeUrl }, env: {}, config: {} }
    })

    const report = {}
    for (const [name, read] of instance.telemetry) {
      try {
        report[name] = await read({})
      } catch (err) {
        report[name] = { error: err.message }
      }
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await mock.close()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
