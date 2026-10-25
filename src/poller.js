'use strict'

const { C2poolApi } = require('./api/client')
const { poll } = require('./snapshot')
const { evaluate, offline, isStale } = require('./health')
const { ERROR_CACHE_MS } = require('./constants')

/**
 * Owns the polling of one node for one device.
 *
 *  - A snapshot is reused for config.pollIntervalMs, so a metrics pull of
 *    every channel costs one poll.
 *  - Concurrent readers share one in-flight poll.
 *  - A failed poll is rethrown for ERR_CACHE_MS, so a down node costs one
 *    request (and at most one timeout) per pull, not one per channel.
 *  - Health is evaluated once per successful snapshot, against the previous
 *    successful one.
 *  - The node identity is reused for an hour (see snapshot.fetchResponses).
 */
class Poller {
  /**
   * @param {object} options
   * @param {object} options.config parseConfig() output
   * @param {{ get: Function }} [options.api] defaults to a C2poolApi for config.nodeUrl
   * @param {() => number} [options.now] clock, ms
   */
  constructor ({ config, api, now = Date.now }) {
    this.config = config
    this._api = api || new C2poolApi({ nodeUrl: config.nodeUrl, timeoutMs: config.timeoutMs })
    this._now = now
    this._cached = null
    this._inFlight = null
    this._last = null
  }

  /** The current snapshot; rejects with the poll's ERR_C2POOL_* error. */
  async get () {
    return (await this._entry()).snapshot
  }

  /** The health channel's value. Never rejects. */
  async health () {
    try {
      const entry = await this._entry()
      if (isStale(entry.snapshot, this.config, this._now())) {
        return offline(new Error('ERR_C2POOL_NODE_UNREACHABLE snapshot is stale'))
      }
      return entry.health
    } catch (err) {
      return offline(err)
    }
  }

  _entry () {
    const now = this._now()
    const cached = this._cached
    if (cached && now - cached.at < (cached.error ? ERROR_CACHE_MS : this.config.pollIntervalMs)) {
      return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached)
    }
    if (!this._inFlight) {
      const identity = this._last ? this._last.snapshot.identity : null
      this._inFlight = poll(this._api, this.config, { now, identity })
        .then(snapshot => {
          const health = evaluate(snapshot, this._last ? this._last.snapshot : null, this.config)
          const entry = { at: this._now(), snapshot, health }
          this._last = entry
          this._cached = entry
          return entry
        }, error => {
          this._cached = { at: this._now(), error }
          throw error
        })
        .finally(() => {
          this._inFlight = null
        })
    }
    return this._inFlight
  }
}

module.exports = { Poller }
