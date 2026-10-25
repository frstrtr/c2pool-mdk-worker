'use strict'

const { C2poolApiError, DataError, ConfigError } = require('../errors')
const { DEFAULT_NODE_URL, DEFAULTS, PATHS, MAX_BODY_BYTES } = require('../constants')

/**
 * Read-only client for a c2pool node's web API (default port 8080).
 *
 * The node's REST API is unauthenticated JSON over GET. This client can only
 * send GET, only to the paths in PATHS, never follows a redirect, and gives
 * every request a finite timeout. It knows nothing about MDK.
 */
class C2poolApi {
  /**
   * @param {object} [options]
   * @param {string} [options.nodeUrl]   http(s) origin, optionally with a path prefix (reverse proxy)
   * @param {number} [options.timeoutMs] per-request timeout, body included
   * @param {number} [options.maxBodyBytes] largest response body read
   * @param {Function} [options.fetch]   test seam; defaults to the global fetch
   */
  constructor ({ nodeUrl = DEFAULT_NODE_URL, timeoutMs = DEFAULTS.timeoutMs, maxBodyBytes = MAX_BODY_BYTES, fetch = globalThis.fetch } = {}) {
    if (!(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)) {
      throw new ConfigError('ERR_C2POOL_CONFIG_INVALID', 'timeoutMs')
    }
    this._base = parseNodeUrl(nodeUrl)
    this._timeoutMs = timeoutMs
    this._maxBodyBytes = maxBodyBytes
    this._fetch = fetch
  }

  /**
   * GET one allow-listed path and parse its JSON body.
   * @param {string} path one of PATHS
   * @returns {Promise<unknown>}
   */
  async get (path) {
    if (!PATHS.includes(path)) {
      throw new Error(`ERR_C2POOL_PATH_NOT_ALLOWED ${String(path).slice(0, 64)}`)
    }

    let res
    try {
      res = await this._fetch(this._base + path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(this._timeoutMs)
      })
    } catch (err) {
      throw new C2poolApiError(path, 0, transportCode(err))
    }

    // redirect: 'manual' hands back the 3xx itself; it counts as an error.
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {})
      throw new C2poolApiError(path, res.status)
    }

    const text = await readText(res, path, this._maxBodyBytes)
    try {
      return JSON.parse(text)
    } catch {
      throw new DataError(`${path} (invalid JSON)`)
    }
  }
}

/**
 * Read a response body as UTF-8, refusing one larger than `limit` bytes:
 * by Content-Length when the node sends it, otherwise while streaming.
 */
async function readText (res, path, limit) {
  const tooLarge = (size) => new DataError(`${path} (response is ${size} bytes, over the ${limit} byte limit)`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge(declared)
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel().catch(() => {})
        throw tooLarge(`at least ${size}`)
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof DataError) throw err
    throw new C2poolApiError(path, 0, transportCode(err))
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate a node URL and return the base every path is appended to:
 * origin plus an optional path prefix, without a trailing slash.
 * Throws ERR_C2POOL_NODE_URL_INVALID for anything but a plain http(s) URL,
 * and for a prefix that would put requests under /control.
 */
function parseNodeUrl (value) {
  const invalid = () => new ConfigError('ERR_C2POOL_NODE_URL_INVALID')
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw invalid()
  if (value.includes('?') || value.includes('#')) throw invalid()

  let url
  try {
    url = new URL(value)
  } catch {
    throw invalid()
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid()
  if (url.username || url.password) throw invalid()

  const prefix = url.pathname.replace(/\/+$/, '')
  const segments = prefix.split('/').filter(Boolean)
  if (segments.some(s => s.toLowerCase() === 'control' || s.includes('%'))) throw invalid()

  return url.origin + prefix
}

// fetch rejects with a TypeError whose cause carries the socket code
// (ECONNREFUSED, ENOTFOUND, ...); AbortSignal.timeout rejects with TimeoutError.
// A port on the fetch spec's blocked list (e.g. 9, 6667) never leaves the process.
function transportCode (err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'TIMEOUT'
  if (err?.cause?.message === 'bad port') return 'BAD_PORT'
  const code = err?.cause?.code || err?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'FETCH_FAILED'
}

module.exports = { C2poolApi, parseNodeUrl }
