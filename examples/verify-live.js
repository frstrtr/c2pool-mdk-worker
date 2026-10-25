'use strict'

// Run every contract handler, read-only, against a real c2pool node.
//
//   C2POOL_NODE_URL=http://127.0.0.1:8080 [C2POOL_ADDRESSES=addr1,addr2] [C2POOL_COIN=BTC] \
//     node examples/verify-live.js
//
// Prints each channel's value or FAILED, and exits 1 if any channel failed,
// returned the wrong type, or put an IP-address-like string in its output.
// The worker only ever sends GET to its allow-list of paths; this script
// adds nothing to that and refuses a node URL whose path is under /control.

const path = require('node:path')
const { loadContract, createInstance } = require('../src/mdk')
const contract = require('../mdk-contract.json')

const PKG_DIR = path.join(__dirname, '..')
const TYPE_OK = {
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
}
// Documented as null when the node knows no block yet.
const NULLABLE = new Set(['last_block_found'])
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
const IPV6 = /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/i

async function main () {
  const nodeUrl = process.env.C2POOL_NODE_URL || 'http://127.0.0.1:8080'
  if (/\/control(\/|$)/i.test(new URL(nodeUrl).pathname)) {
    throw new Error('refusing a node URL under /control: this worker is read-only')
  }
  const opts = { nodeUrl }
  if (process.env.C2POOL_ADDRESSES) opts.addresses = process.env.C2POOL_ADDRESSES.split(',').map(a => a.trim()).filter(Boolean)
  if (process.env.C2POOL_COIN) opts.coin = process.env.C2POOL_COIN

  const instance = createInstance({
    dir: PKG_DIR,
    entries: loadContract(PKG_DIR).entries,
    device: { id: 'c2pool-live', opts, env: {}, config: {} }
  })

  let failed = 0
  for (const entry of contract.capabilities.telemetry) {
    let value
    try {
      value = await instance.telemetry.get(entry.name)({})
    } catch (err) {
      failed++
      console.log(`${entry.name}: FAILED ${err.message}`)
      continue
    }
    const text = JSON.stringify(value)
    const typeOk = TYPE_OK[entry.type](value) || (value === null && NULLABLE.has(entry.name))
    const leak = IPV4.test(text) || IPV6.test(text)
    if (!typeOk || leak) failed++
    const verdict = !typeOk ? `FAILED not a ${entry.type}: ` : leak ? 'FAILED IP-like string in output: ' : ''
    console.log(`${entry.name}: ${verdict}${summarize(entry.name, value, text)}`)
  }

  console.log(failed ? `\n${failed} channel(s) FAILED` : '\nall channels OK')
  process.exitCode = failed ? 1 : 0
}

function summarize (name, value, text) {
  if (name === 'workers' && Array.isArray(value)) {
    return `${value.length} row(s)${value.length ? `, first ${JSON.stringify(value[0])}` : ''}`
  }
  return text.length > 400 ? `${text.slice(0, 400)}...` : text
}

main().catch(err => {
  console.error(err.message)
  process.exitCode = 1
})
