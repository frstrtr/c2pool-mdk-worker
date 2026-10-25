'use strict'

// Device spec for the MDK smoke check (`npm run validate:worker`, or
// `mdk validate worker --path . --smoke`): setup() starts the mock node on
// the DASH fixture and returns how to reach it, and teardown() stops it.
//
// After teardown() the smoke run expects every channel to fail with an
// ERR_* (health instead reports OFFLINE). The worker serves its last snapshot
// for pollIntervalMs, so the device uses the shortest interval and teardown()
// waits it out before returning. No offlineTelemetry: nothing is served from
// a store.

const { setTimeout: sleep } = require('node:timers/promises')
const { createServer } = require('./mock/server')
const { MIN_POLL_INTERVAL_MS } = require('./src/constants')

module.exports = {
  async setup () {
    const mock = await createServer({ port: 0, coin: 'dash' })
    return {
      deviceId: 'c2pool-0',
      config: { nodeUrl: mock.nodeUrl, pollIntervalMs: MIN_POLL_INTERVAL_MS },
      teardown: async () => {
        await mock.close()
        await sleep(MIN_POLL_INTERVAL_MS + 250)
      }
    }
  }
}
