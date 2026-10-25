'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('last_block_found')
