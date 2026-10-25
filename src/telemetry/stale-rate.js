'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('stale_rate')
