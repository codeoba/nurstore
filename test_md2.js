const { Telegraf } = require('telegraf')
const config = require('./src/config')
const bot = new Telegraf(config.botToken)
bot.telegram.sendMessage(config.admin.ids[0], '?? *Lipia kwa M-Pesa*', { parse_mode: 'MarkdownV2' }).then(() => console.log('OK')).catch(e => console.error(e.message))
