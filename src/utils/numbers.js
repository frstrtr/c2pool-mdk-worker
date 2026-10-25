'use strict'

const { DataError } = require('../errors')

/**
 * A missing or malformed reading must never become a valid zero.
 * @param {unknown} value
 * @param {string} field  reported in the error message
 * @returns {number}
 */
function toNumber (value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DataError(field)
  }
  return value
}

/** Like toNumber, but a field the node may omit or report as null yields null. */
function toOptionalNumber (value, field) {
  if (value === null || value === undefined) return null
  return toNumber(value, field)
}

function toBoolean (value, field) {
  if (typeof value !== 'boolean') throw new DataError(field)
  return value
}

function toOptionalBoolean (value, field) {
  if (value === null || value === undefined) return null
  return toBoolean(value, field)
}

function toOptionalString (value, field) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new DataError(field)
  return value
}

function sum (values) {
  let total = 0
  for (const v of values) total += v
  return total
}

/** Coin amounts travel as floats with 1e-8 resolution; keep sums on that grid. */
function roundCoins (value) {
  return Math.round(value * 1e8) / 1e8
}

module.exports = {
  toNumber,
  toOptionalNumber,
  toBoolean,
  toOptionalBoolean,
  toOptionalString,
  sum,
  roundCoins
}
