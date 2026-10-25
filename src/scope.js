'use strict'

/**
 * Split a stratum username into its payout addresses and worker name.
 *
 *   'ADDR.rig1'          -> { addresses: ['ADDR'], primary: 'ADDR', worker: 'rig1' }
 *   'LTCADDR,DOGEADDR.w' -> { addresses: ['LTCADDR', 'DOGEADDR'], primary: 'LTCADDR', worker: 'w' }
 *
 * The address part is the text before the first '.', the primary address is
 * its first ','-separated token. A p2pool difficulty suffix on an address
 * ('ADDR+512', 'ADDR/512') is dropped; no address charset contains + or /.
 */
function parseUsername (name) {
  const text = String(name)
  const dot = text.indexOf('.')
  const head = dot === -1 ? text : text.slice(0, dot)
  const worker = dot === -1 ? '' : text.slice(dot + 1)
  const addresses = head.split(',').map(a => a.replace(/[+/].*$/, '')).filter(Boolean)
  return { name: text, addresses, primary: addresses[0] || '', worker }
}

/**
 * The payout addresses this device reports on: the configured ones, or,
 * when none are configured, the primary address of every stratum worker
 * connected to this node.
 * @param {{ address: string }[]} workers normalized worker rows
 * @param {{ addresses: string[] }} config
 * @returns {Set<string>}
 */
function scopeAddresses (workers, config) {
  if (config.addresses.length > 0) return new Set(config.addresses)
  return new Set(workers.map(w => w.address).filter(Boolean))
}

/** Exact-string match; the node is the authority on address formats. */
function inScope (address, scope) {
  return typeof address === 'string' && scope.has(address)
}

module.exports = { parseUsername, scopeAddresses, inScope }
