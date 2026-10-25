'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('network_difficulty')
