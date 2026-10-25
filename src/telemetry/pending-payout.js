'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('pending_payout')
