'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('hashrate_dead')
