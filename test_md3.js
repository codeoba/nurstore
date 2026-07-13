const { Telegraf } = require('telegraf')
const config = require('./src/config')
const bot = new Telegraf(config.botToken)
bot.telegram.sendMessage(config.admin.ids[0], '?? *TZS 10,000*', { parse_mode: 'MarkdownV2' }).then(() => console.log('OK')).catch(e => console.error(e.message))
