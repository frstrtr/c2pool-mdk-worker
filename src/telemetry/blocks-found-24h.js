'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('blocks_found_24h')
