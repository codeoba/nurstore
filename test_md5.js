const { Telegraf } = require('telegraf')
const config = require('../../scratch/telegram-store-bot/src/config')
const { escapeMarkdown } = require('../../scratch/telegram-store-bot/src/utils/formatting')

const bot = new Telegraf(config.bot.token)

const networkName = 'M-Pesa'
const productName = 'Netflix 1 Mwezi (4K)'
const price = 10000
const number = '0794 625529'
const ownerName = 'Duka Lako'

const text = `📱 *Lipia kwa ${escapeMarkdown(networkName)}*\n\n` +
  `Tafadhali fuata hatua zifuatazo kukamilisha ununuzi wa *${escapeMarkdown(productName)}*:\n\n` +
  `1️⃣ Tuma kiasi cha *TZS ${price.toLocaleString('en-US')}* kwenda namba hii:\n` +
  `📞 Namba: \`${escapeMarkdown(number)}\`\n` +
  `👤 Jina: *${escapeMarkdown(ownerName)}*\n\n` +
  `2️⃣ Baada ya kutuma, piga *screenshot* \\(picha\\) au nakili *ID ya muamala*\\.\n\n` +
  `3️⃣ Tuma picha au meseji ya muamala hapa \\(reply kwenye chat hii\\) ili tuhakiki na kukutumia bidhaa yako\\.\n\n` +
  `⏳ _Una dakika 12 pekee kukamilisha malipo na kutuma uthibitisho kabla oda yako kufutwa\\._`

console.log('Sending text:');
console.log(text);

bot.telegram.sendMessage(config.admin.ids[0], text, { parse_mode: 'MarkdownV2' })
  .then(() => console.log('OK'))
  .catch(e => console.error('TELEGRAM API ERROR:', e.message))
