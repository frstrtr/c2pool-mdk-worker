'use strict'

const test = require('brittle')
const pkg = require('../../package.json')
const lock = require('../../package-lock.json')

const MDK_GIT = /^git\+https:\/\/github\.com\/tetherto\/mdk\.git#([0-9a-f]{40})$/

test('MDK is pinned to one commit and the lockfile fetches it over https', t => {
  const spec = pkg.devDependencies['@tetherto/mdk']
  const pinned = MDK_GIT.exec(spec)
  t.ok(pinned, `package.json pins a full commit SHA over git+https: ${spec}`)

  const resolved = lock.packages['node_modules/@tetherto/mdk'].resolved
  // npm install records GitHub dependencies as git+ssh; CI runners have no
  // SSH key for github.com. Restore with:
  //   sed -i 's|git+ssh://git@github.com/tetherto/mdk.git|git+https://github.com/tetherto/mdk.git|' package-lock.json
  t.is(resolved, spec, 'package-lock.json resolves MDK over git+https at the same commit')
  t.is(pkg.peerDependencies['@tetherto/mdk'], '*', 'hosts bring their own MDK')
})
