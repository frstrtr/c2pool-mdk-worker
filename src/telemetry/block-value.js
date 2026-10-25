'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('block_value')
