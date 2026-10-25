'use strict'

const { readChannel } = require('../client')

module.exports = async () => readChannel('share_difficulty')
