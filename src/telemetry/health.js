'use strict'

const { getHealth } = require('../client')

// Replaces MDK's builtin health channel, which answers OK whatever the node
// does: this one reports OFFLINE when the node cannot be polled.
module.exports = async () => getHealth()
