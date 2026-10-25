'use strict'

// WorkerRuntimeV2 loads this module once per device, into that device's own
// module registry, so the poller below belongs to the one node this device
// reports on.
const { opts } = require('@tetherto/mdk-worker/device')
const { parseConfig } = require('./config')
const { Poller } = require('./poller')
const { read } = require('./snapshot')
const { offline } = require('./health')

let poller = null

// Config errors surface on the first telemetry call, not at load time, so a
// misconfigured device reports an error instead of failing the whole worker.
function getPoller () {
  if (!poller) poller = new Poller({ config: parseConfig(opts) })
  return poller
}

async function getSnapshot () {
  return getPoller().get()
}

/** One channel's value from the shared snapshot, or its ERR_C2POOL_* error. */
async function readChannel (name) {
  return read(await getSnapshot(), name)
}

async function getHealth () {
  let current
  try {
    current = getPoller()
  } catch (err) {
    return offline(err)
  }
  return current.health()
}

module.exports = { getSnapshot, readChannel, getHealth }
