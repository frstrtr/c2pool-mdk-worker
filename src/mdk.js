'use strict'

// MDK is not on npm yet: the host installs the monorepo from git and its
// packages are reachable only by path. This is the one file that knows that
// layout. The umbrella package has no exports map, so the deep paths resolve
// on v0.12. When @tetherto/mdk-worker is published, replace these requires
// with the package names.
//
// The handler files never require this module: they read their device from
// the ambient '@tetherto/mdk-worker/device', which WorkerRuntimeV2 provides.
const { WorkerRuntimeV2, loadContract, createInstance, validateContract } = require('@tetherto/mdk/backend/core/mdk-worker')
const actions = require('@tetherto/mdk/backend/core/kernel/lib/protocol/actions')
const envelope = require('@tetherto/mdk/backend/core/kernel/lib/protocol/envelope')

module.exports = {
  WorkerRuntimeV2,
  loadContract,
  createInstance,
  validateContract,
  protocol: { ...actions, ...envelope },

  // Kernel side, for tests and examples; loaded on first use only.
  get kernel () {
    return require('@tetherto/mdk/backend/core/mdk')
  },
  get client () {
    return require('@tetherto/mdk/backend/core/client')
  }
}
