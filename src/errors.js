'use strict'

/**
 * A request to the node failed. `status` is the HTTP status, or 0 when no
 * response arrived; `code` is then the transport code (ECONNREFUSED,
 * TIMEOUT, ...). The message never carries the response body or the URL's
 * host, only the path.
 */
class C2poolApiError extends Error {
  constructor (path, status, code = null) {
    const kind = status ? 'ERR_C2POOL_HTTP' : 'ERR_C2POOL_NODE_UNREACHABLE'
    super(`${kind} ${path} ${status || code || 'FETCH_FAILED'}`)
    this.path = path
    this.status = status
    this.code = code
  }
}

/** A field in an otherwise valid response is missing or malformed. */
class DataError extends Error {
  constructor (field) {
    super(`ERR_C2POOL_DATA ${field}`)
    this.field = field
  }
}

/** The device config is invalid; `code` is one of the ERR_C2POOL_* config codes. */
class ConfigError extends Error {
  constructor (code, detail) {
    super(detail ? `${code} ${detail}` : code)
    this.code = code
  }
}

const CODE = /^(ERR_[A-Z0-9_]+|E_[A-Z0-9_]+)/

/** True when the error carries a stable MDK error code at the start of its message. */
function hasCode (err) {
  return typeof err?.message === 'string' && CODE.test(err.message)
}

/** The stable code at the start of an error, for the health channel. */
function errorCode (err) {
  return CODE.exec(err?.message || '')?.[1] || 'E_POOL_API'
}

module.exports = { C2poolApiError, DataError, ConfigError, hasCode, errorCode }
