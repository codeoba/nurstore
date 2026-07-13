'use strict'

const { Markup } = require('telegraf')
const config = require('../config')
const logger = require('../utils/logger')
const { isDiscountActive, escapeMarkdown } = require('../utils/formatting')

/**
 * Tuma post kwenye channel
 */
async function postToChannel(bot, product, isNewProduct = false, addedStock = 0) {
  if (!config.bot.channelId) return

  try {
    const botInfo = await bot.telegram.getMe()
    const botUsername = botInfo.username

    const activeDiscount = isDiscountActive(product)
    const tzs = activeDiscount ? product.discountTzs : product.priceTzs

    const header = isNewProduct ? `🆕 *New Product Added!*` : `📦 *Stock Updated!*`
    
    let text = `${header}\n`
    text += `🤖 *${escapeMarkdown(product.name)}*\n\n`
    
    if (addedStock > 0) {
      text += `✅ New stock added: ${addedStock} pcs\n`
    } else if (isNewProduct) {
      text += `💰 Price: TZS ${tzs.toLocaleString('en-US')}\n`
    }

    if (product.stock !== null) {
      text += `📦 Available now: ${product.stock} pcs\n\n`
    } else {
      text += `📦 Available now: Unlimited\n\n`
    }

    text += `🛒 Order now 👉 @${escapeMarkdown(botUsername)}`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url('🛒 Buy now', `https://t.me/${botUsername}?start=prod_${product.id}`)]
    ])

    if (product.thumbnailFileId) {
      await bot.telegram.sendPhoto(config.bot.channelId, product.thumbnailFileId, {
        caption: text,
        parse_mode: 'MarkdownV2',
        ...keyboard
      })
    } else if (product.thumbnailPath) {
      const fs = require('fs')
      const path = require('path')
      const fullPath = path.isAbsolute(product.thumbnailPath)
        ? product.thumbnailPath
        : path.join(config.storage.uploadDir, product.thumbnailPath)
      
      if (fs.existsSync(fullPath)) {
        await bot.telegram.sendPhoto(config.bot.channelId, { source: fullPath }, {
          caption: text,
          parse_mode: 'MarkdownV2',
          ...keyboard
        })
      } else {
        await bot.telegram.sendMessage(config.bot.channelId, text, {
          parse_mode: 'MarkdownV2',
          ...keyboard
        })
      }
    } else {
      await bot.telegram.sendMessage(config.bot.channelId, text, {
        parse_mode: 'MarkdownV2',
        ...keyboard
      })
    }

    logger.info('Successfully posted to channel', { productId: product.id, isNewProduct })
  } catch (err) {
    logger.error('Failed to post to channel', { error: err.message, productId: product.id })
  }
}

module.exports = {
  postToChannel
}
