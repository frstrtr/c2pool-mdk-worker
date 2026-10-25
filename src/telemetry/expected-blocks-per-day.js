'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('expected_blocks_per_day')
