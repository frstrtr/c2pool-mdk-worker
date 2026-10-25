'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('pool_hashrate')
