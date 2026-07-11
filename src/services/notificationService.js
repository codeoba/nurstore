'use strict'

const { prisma } = require('../database')
const logger = require('../utils/logger')
const config = require('../config')

/**
 * Tuma notification kwa admin/admins kuhusu event muhimu
 * @param {object} bot - Telegraf bot instance
 * @param {string} message - Ujumbe wa kutuma
 */
async function notifyAdmins(bot, message) {
  for (const adminId of config.admin.ids) {
    try {
      await bot.telegram.sendMessage(adminId, message, { parse_mode: 'MarkdownV2' })
    } catch (err) {
      logger.error('Failed to notify admin', { adminId, error: err.message })
    }
  }
}

/**
 * Tuma notification ya order mpya kwa admin
 */
async function notifyAdminNewOrder(bot, order, user) {
  const username = user.username ? `@${user.username}` : user.fullName || String(user.telegramId)
  const msg = [
    `🛍️ *Order Mpya \\#${order.id}\\!*`,
    ``,
    `👤 Mteja: ${escMd(username)}`,
    `💫 Stars: ⭐ ${order.totalStars}`,
    `📦 Bidhaa: ${order.items?.length || 0}`,
    `💳 Malipo: ${order.paymentMethod === 'telegram_stars' ? '⭐ Telegram Stars' : 'Manual'}`,
    order.isFlagged ? `\n⚠️ *IMEWEKWA BENDERA* \\- Angalia!` : '',
  ].filter(Boolean).join('\n')

  await notifyAdmins(bot, msg)
}

/**
 * Tuma notification ya malipo yaliyofanikiwa kwa admin
 */
async function notifyAdminPaymentReceived(bot, order) {
  const msg = [
    `✅ *Malipo Yamepokelewa\\!*`,
    ``,
    `📋 Order \\#${order.id}`,
    `💫 Stars: ⭐ ${order.totalStars}`,
    `💳 Charge ID: \`${escMd(order.paymentReference || 'N/A')}\``,
  ].join('\n')

  await notifyAdmins(bot, msg)
}

/**
 * Tuma notification ya mtumiaji mpya kwa admin
 */
async function notifyAdminNewUser(bot, user) {
  const msg = [
    `👤 *Mtumiaji Mpya!*`,
    ``,
    `🆔 ID: \`${user.telegramId}\``,
    `👤 Jina: ${escMd(user.fullName || 'Bila jina')}`,
    user.username ? `📛 Username: @${escMd(user.username)}` : '',
    `📅 Tarehe: ${escMd(new Date().toLocaleDateString('sw-TZ'))}`,
  ].filter(Boolean).join('\n')

  await notifyAdmins(bot, msg)
}

/**
 * Tuma broadcast message kwa wateja wote au segment
 *
 * @param {object} bot - Telegraf bot instance
 * @param {string} message - Ujumbe wa kutuma
 * @param {object} filters - Optional filters
 * @param {number} filters.categoryId - Tuma kwa waliokuwa category hii
 * @param {boolean} filters.hasPurchased - Tuma kwa waliowahi kununua
 * @returns {{ sent: number, failed: number }}
 */
async function broadcastMessage(bot, message, filters = {}) {
  let users

  if (filters.categoryId) {
    // Tuma kwa waliowahi kununua bidhaa kwenye category hii
    users = await prisma.user.findMany({
      where: {
        isBlocked: false,
        orders: {
          some: {
            status: { in: ['paid', 'delivered'] },
            items: {
              some: {
                product: { categoryId: filters.categoryId },
              },
            },
          },
        },
      },
      select: { telegramId: true },
    })
  } else if (filters.hasPurchased) {
    // Tuma kwa waliowahi kununua chochote
    users = await prisma.user.findMany({
      where: {
        isBlocked: false,
        orders: { some: { status: { in: ['paid', 'delivered'] } } },
      },
      select: { telegramId: true },
    })
  } else {
    // Tuma kwa wote
    users = await prisma.user.findMany({
      where: { isBlocked: false },
      select: { telegramId: true },
    })
  }

  let sent = 0
  let failed = 0

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(Number(user.telegramId), message, {
        parse_mode: 'MarkdownV2',
      })
      sent++
      // Punguza kasi ili kuzuia Telegram rate limits
      await sleep(100)
    } catch (err) {
      failed++
      if (err.description?.includes('bot was blocked')) {
        // User amezuia bot - weka kwenye kumbukumbu
        logger.info('User blocked bot during broadcast', { telegramId: user.telegramId })
      }
    }
  }

  logger.info('Broadcast completed', { sent, failed, total: users.length })
  return { sent, failed }
}

/**
 * Tuma reminder ya cart iliyoachwa
 */
async function sendAbandonedCartReminder(bot, user, cartItems) {
  const itemNames = cartItems.slice(0, 3).map(i => i.product.name).join(', ')
  const lang = user.language || 'sw'

  const msg = lang === 'sw'
    ? `🛒 *Kikapu Chako Kinakungoja\\!*\n\n` +
      `Umesahau bidhaa zako:\n_${escMd(itemNames)}_${cartItems.length > 3 ? ` na zingine ${cartItems.length - 3}` : ''}\n\n` +
      `Rudi na ukamilishe ununuzi wako: /start`
    : `🛒 *Your Cart is Waiting!*\n\n` +
      `You left some items:\n_${escMd(itemNames)}_${cartItems.length > 3 ? ` and ${cartItems.length - 3} more` : ''}\n\n` +
      `Return and complete your purchase: /start`

  try {
    await bot.telegram.sendMessage(Number(user.telegramId), msg, { parse_mode: 'MarkdownV2' })
    logger.info('Abandoned cart reminder sent', { telegramId: user.telegramId })
  } catch (err) {
    logger.error('Failed to send cart reminder', { error: err.message })
  }
}

/**
 * Tuma notification ya referral commission kwa mwasilishaji
 */
async function notifyReferralCommission(bot, referrerTelegramId, commission, buyerName) {
  const msg = `🎉 *Commission Yako\\!*\n\n` +
    `${escMd(buyerName || 'Mtu')} aliyekualika amenunua\\!\n` +
    `💫 Umepata: ⭐ *${commission}* Stars\n\n` +
    `Angalia jumla yako ya commission: /start`

  try {
    await bot.telegram.sendMessage(referrerTelegramId, msg, { parse_mode: 'MarkdownV2' })
  } catch (err) {
    logger.error('Failed to notify referral commission', { error: err.message })
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function escMd(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  notifyAdmins,
  notifyAdminNewOrder,
  notifyAdminPaymentReceived,
  notifyAdminNewUser,
  broadcastMessage,
  sendAbandonedCartReminder,
  notifyReferralCommission,
}
