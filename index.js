'use strict'

// The package is a directory-loaded MDK Worker plugin: mdk-contract.json and
// the handler files it names. A host points WorkerRuntimeV2 at `plugin.dir`.
module.exports = {
  plugin: {
    dir: __dirname,
    contract: require('./mdk-contract.json')
  }
}
