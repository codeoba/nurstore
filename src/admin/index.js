'use strict'

const { Markup } = require('telegraf')
const { isAdmin } = require('../middlewares/auth')
const { escapeMarkdown } = require('../utils/formatting')
const { prisma } = require('../database')
const logger = require('../utils/logger')

// ─── Admin Main Menu ──────────────────────────────────────────

/**
 * Onyesha main menu ya admin na statistics za leo
 */
async function showAdminMenu(ctx) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Statistics za haraka
  const [todayOrders, todayRevenue, totalProducts, pendingOrders] = await Promise.all([
    prisma.order.count({ where: { status: 'paid', paidAt: { gte: today } } }),
    prisma.order.aggregate({
      where: { status: { in: ['paid', 'delivered'] }, paidAt: { gte: today } },
      _sum: { totalTzs: true },
    }),
    prisma.product.count({ where: { isActive: true } }),
    prisma.order.count({ where: { status: 'pending' } }),
  ])

  const adminName = escapeMarkdown(ctx.from.first_name || 'Admin')
  const revenue = todayRevenue._sum.totalTzs || 0

  const text = [
    `👨‍💼 *Admin Panel — ${escapeMarkdown(require('../config').bot.storeName)}*`,
    `Karibu, ${adminName}\\!`,
    ``,
    `📊 *Takwimu za Leo:*`,
    `🛍️ Maagizo: *${todayOrders}*`,
    `💫 Mapato: *TZS ${revenue.toLocaleString('en-US')}*`,
    `⏳ Yanayosubiri: *${pendingOrders}*`,
    `📦 Bidhaa: *${totalProducts}*`,
    ``,
    `Chagua sehemu unayotaka:`,
  ].join('\n')

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📦 Bidhaa', 'admin:products'),
      Markup.button.callback('📋 Maagizo', 'admin:orders'),
    ],
    [
      Markup.button.callback('👥 Wateja', 'admin:customers'),
      Markup.button.callback('📊 Ripoti', 'admin:analytics'),
    ],
    [
      Markup.button.callback('🎟️ Coupons', 'admin:coupons'),
      Markup.button.callback('📣 Broadcast', 'admin:broadcast'),
    ],
    [
      Markup.button.callback('⚙️ Mipangilio', 'admin:settings'),
    ],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
    await ctx.answerCbQuery()
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

/**
 * Unda button ya "Rudi Admin Menu"
 */
function backToAdminMenuButton() {
  return Markup.inlineKeyboard([[
    Markup.button.callback('◀️ Admin Menu', 'admin:menu'),
  ]])
}

/**
 * Register admin command handlers kwenye bot
 * @param {import('telegraf').Telegraf} bot
 */
function registerAdminRouter(bot) {
  // Amri ya /admin — inaonyesha admin panel
  bot.command('admin', isAdmin, (ctx) => showAdminMenu(ctx))

  // Callback kwa admin menu
  bot.action('admin:menu', isAdmin, (ctx) => showAdminMenu(ctx))

  // ─── Products ─────────────────────────────────────────────
  const { registerAdminProductHandlers, registerWizardCategoryCallback } = require('./products')
  registerAdminProductHandlers(bot)
  registerWizardCategoryCallback(bot)

  // ─── Orders ──────────────────────────────────────────────
  const { registerAdminOrderHandlers } = require('./orders')
  registerAdminOrderHandlers(bot)

  // ─── Customers ────────────────────────────────────────────
  const { registerAdminCustomerHandlers } = require('./customers')
  registerAdminCustomerHandlers(bot)

  // ─── Analytics ────────────────────────────────────────────
  const { registerAdminAnalyticsHandlers } = require('./analytics')
  registerAdminAnalyticsHandlers(bot)

  // ─── Settings ─────────────────────────────────────────────
  const { registerAdminSettingsHandlers, registerAddAdminRoleCallback } = require('./settings')
  registerAdminSettingsHandlers(bot)
  registerAddAdminRoleCallback(bot)

  // ─── Coupons ──────────────────────────────────────────────
  registerCouponHandlers(bot)

  // ─── Broadcast ────────────────────────────────────────────
  registerBroadcastHandlers(bot)

  // ─── Refund Approval/Rejection ────────────────────────────────
  bot.action(/^admin:refund:(approve|reject):(\d+)$/, isAdmin, async (ctx) => {
    const action = ctx.match[1]
    const requestId = parseInt(ctx.match[2])
    const status = action === 'approve' ? 'approved' : 'rejected'

    await ctx.answerCbQuery(action === 'approve' ? '✅ Inaidhinisha refund...' : '❌ Inakataa refund...')

    try {
      const { resolveRefundRequest } = require('../services/refundService')
      const { request, order, clientUserId } = await resolveRefundRequest(requestId, status, ctx.from.id)

      // Notify admin in chat
      await ctx.editMessageText(
        `🔄 *Ombi la Refund #${request.orderId} limekamilika\\!*\n\n` +
        `Hali: ${status === 'approved' ? 'IMEIDHINISHWA ✅' : 'IMEKATALIWA ❌'}\n` +
        `Kiasi: TZS ${order.totalTzs.toLocaleString('en-US')}\n` +
        `Mteja alijulishwa kiotomatiki\\.`,
        { parse_mode: 'MarkdownV2' }
      )

      // Notify customer
      const clientUser = await prisma.user.findUnique({
        where: { id: clientUserId },
        select: { telegramId: true, language: true }
      })

      if (clientUser) {
        const notifyMsg = clientUser.language === 'sw'
          ? (status === 'approved'
              ? `✅ *Ombi la Refund Limekubaliwa\\!*\n\nKiasi cha TZS *${order.totalTzs.toLocaleString('en-US')}* kimerudishwa kwenye Wallet yako\\. Salio jipya linaonyeshwa kwenye Wasifu wako\\.`
              : `❌ *Ombi la Refund Limekataliwa\\!*\n\nOmbi lako la kurejeshewa pesa kwa Order \\#${order.id} limekataliwa na wasimamizi\\. Kama una maswali wasiliana na msaada wetu\\.`)
          : (status === 'approved'
              ? `✅ *Refund Request Approved\\!*\n\nThe amount of TZS *${order.totalTzs.toLocaleString('en-US')}* has been credited back to your Wallet\\. View your updated balance in your Profile\\.`
              : `❌ *Refund Request Rejected\\!*\n\nYour refund request for Order \\#${order.id} has been rejected by the admin\\. Please contact support if you have any questions\\.`)

        await ctx.telegram.sendMessage(Number(clientUser.telegramId), notifyMsg, { parse_mode: 'MarkdownV2' }).catch(() => {})
      }
    } catch (err) {
      logger.error('Failed to resolve refund request', { error: err.message, requestId })
      await ctx.reply(`❌ Hitilafu: ${err.message}`)
    }
  })

  // ─── Deposit Approval/Rejection ───────────────────────────────
  bot.action(/^admin:deposit:(approve|reject):(\d+)$/, isAdmin, async (ctx) => {
    const action = ctx.match[1]
    const txId = parseInt(ctx.match[2])

    await ctx.answerCbQuery(action === 'approve' ? '✅ Inaidhinisha...' : '❌ Inakataa...')

    try {
      const { creditWallet } = require('../services/walletService')

      // Pata transaction
      const tx = await prisma.walletTransaction.findUnique({
        where: { id: txId },
        include: { wallet: { include: { user: { select: { telegramId: true, language: true, id: true } } } } },
      })

      if (!tx) {
        await ctx.reply('❌ Transaction haikupatikana.')
        return
      }

      if (tx.status !== 'pending') {
        await ctx.editMessageText(
          `⚠️ *Transaction hii tayari imeshughulikiwa\\!*\n\nHali ya sasa: *${escapeMarkdown(tx.status)}*`,
          { parse_mode: 'MarkdownV2' }
        )
        return
      }

      const adminName = escapeMarkdown(ctx.from.first_name || 'Admin')

      if (action === 'approve') {
        // Ongeza salio moja kwa moja bila kuunda transaction mpya
        await prisma.$transaction([
          prisma.wallet.update({
            where: { id: tx.walletId },
            data: { balance: { increment: tx.amount } },
          }),
          prisma.walletTransaction.update({
            where: { id: txId },
            data: { status: 'completed', completedAt: new Date() },
          }),
        ])

        // Ripoti Admin
        await ctx.editMessageText(
          `✅ *Deposit IMEIDHINISHWA\\!*\n\n` +
          `💰 Kiasi: TZS *${tx.amount.toLocaleString('en-US')}*\n` +
          `🔑 Ref: *${escapeMarkdown(tx.referenceId || 'N/A')}*\n` +
          `👨\u200d💼 Imeidhinishwa na: ${adminName}\n\n` +
          `_Salio la mteja limejazwa kiotomatiki\\._`,
          { parse_mode: 'MarkdownV2' }
        )

        // Notify Customer
        const user = tx.wallet.user
        const notifyMsg = user.language === 'sw'
          ? `✅ *Salio Limewekwa\\!*\n\nTZS *${tx.amount.toLocaleString('en-US')}* imeongezwa kwenye Wallet yako\\. Unaweza kununua bidhaa sasa\\!`
          : `✅ *Balance Added\\!*\n\nTZS *${tx.amount.toLocaleString('en-US')}* has been credited to your Wallet\\. You can now purchase products\\!`

        await ctx.telegram.sendMessage(Number(user.telegramId), notifyMsg, { parse_mode: 'MarkdownV2' }).catch(() => {})

      } else {
        // Kataa — sasisha status
        await prisma.walletTransaction.update({
          where: { id: txId },
          data: { status: 'failed' },
        })

        // Ripoti Admin
        await ctx.editMessageText(
          `❌ *Deposit IMEKATALIWA\\.*\n\n` +
          `💰 Kiasi: TZS *${tx.amount.toLocaleString('en-US')}*\n` +
          `🔑 Ref: *${escapeMarkdown(tx.referenceId || 'N/A')}*\n` +
          `👨\u200d💼 Imekataliwa na: ${adminName}`,
          { parse_mode: 'MarkdownV2' }
        )

        // Notify Customer
        const user = tx.wallet.user
        const notifyMsg = user.language === 'sw'
          ? `❌ *Ombi la Weka Salio Limekataliwa\\.*\n\nOmbi lako la kuongeza TZS *${tx.amount.toLocaleString('en-US')}* haukuidhinishwa\\. Angalia upya Binance Order ID au TxID uliyotuma kisha jaribu tena, au wasiliana na msaada wetu\\.`
          : `❌ *Deposit Request Rejected\\.*\n\nYour request to add TZS *${tx.amount.toLocaleString('en-US')}* was not approved\\. Please verify your Binance Order ID or TxID and try again, or contact support\\.`

        await ctx.telegram.sendMessage(Number(user.telegramId), notifyMsg, { parse_mode: 'MarkdownV2' }).catch(() => {})
      }
    } catch (err) {
      logger.error('Failed to process deposit approval', { error: err.message, txId })
      await ctx.reply(`❌ Hitilafu: ${err.message}`)
    }
  })

  // ─── Mobile Money Checkout Approval/Rejection ──────────────────
  bot.action(/^admin:mobilemoney:(approve|reject):(\d+)$/, isAdmin, async (ctx) => {
    const action = ctx.match[1]
    const orderId = parseInt(ctx.match[2])

    await ctx.answerCbQuery(action === 'approve' ? '✅ Inakagua na kutuma bidhaa...' : '❌ Inakataa...')

    try {
      const { deliverOrder } = require('../services/deliveryService')

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          user: { select: { telegramId: true, language: true, id: true } },
          items: { include: { product: true } },
        },
      })

      if (!order) {
        await ctx.editMessageText('❌ Order haikupatikana.', { parse_mode: 'MarkdownV2' })
        return
      }

      if (order.status !== 'pending') {
        await ctx.editMessageText(
          `⚠️ *Order hii tayari imeshughulikiwa\\.*\n\nHali ya sasa: *${escapeMarkdown(order.status)}*`,
          { parse_mode: 'MarkdownV2' }
        )
        return
      }

      const adminName = escapeMarkdown(ctx.from.first_name || 'Admin')
      const lang = order.user.language || 'sw'
      const productNames = order.items.map(i => i.product.name).join(', ')

      if (action === 'approve') {
        // Sasisha order status → paid
        await prisma.order.update({
          where: { id: orderId },
          data: { status: 'paid', paidAt: new Date(), paymentReference: 'mobilemoney_manual' },
        })

        // Tuma bidhaa kwa mteja mara moja
        const updatedOrder = await prisma.order.findUnique({
          where: { id: orderId },
          include: { items: { include: { product: true } }, user: true },
        })
        await deliverOrder(ctx.telegram, Number(order.user.telegramId), updatedOrder)

        // Ripoti admin
        await ctx.editMessageText(
          `✅ *Malipo YAMEIDHINISHWA na Bidhaa Imetumwa\\!*\n\n` +
          `📦 Bidhaa: *${escapeMarkdown(productNames)}*\n` +
          `💰 Kiasi: TZS *${order.totalTzs.toLocaleString('en-US')}*\n` +
          `👨‍💼 Imeidhinishwa na: ${adminName}\n\n` +
          `_Mteja amepokea bidhaa kiotomatiki\\._`,
          { parse_mode: 'MarkdownV2' }
        )

        // Notify customer with thank you
        const thankMsg = lang === 'sw'
          ? `🎉 *Ununuzi Umekamilika\\!*\n\n` +
            `Malipo yako kwa *${escapeMarkdown(productNames)}* yamethibitishwa\\.\n` +
            `Bidhaa yako imetumwa hapa kwenye chat hii\\.\n\n` +
            `Asante kwa kununua\\! 🙏`
          : `🎉 *Purchase Completed\\!*\n\n` +
            `Your payment for *${escapeMarkdown(productNames)}* has been confirmed\\.\n` +
            `Your product has been delivered in this chat\\.\n\n` +
            `Thank you for your purchase\\! 🙏`

        await ctx.telegram.sendMessage(
          Number(order.user.telegramId), thankMsg,
          {
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [[{ text: '📦 Maagizo Yangu', callback_data: 'store:orders' }]]
            }
          }
        ).catch(() => {})

      } else {
        // Kataa — futa order
        await prisma.order.update({
          where: { id: orderId },
          data: { status: 'cancelled' },
        })

        // Ripoti admin
        await ctx.editMessageText(
          `❌ *Malipo YAMEKATALIWA\\.*\n\n` +
          `📦 Bidhaa: *${escapeMarkdown(productNames)}*\n` +
          `💰 Kiasi: TZS *${order.totalTzs.toLocaleString('en-US')}*\n` +
          `👨‍💼 Imekataliwa na: ${adminName}`,
          { parse_mode: 'MarkdownV2' }
        )

        // Notify customer
        const rejectMsg = lang === 'sw'
          ? `❌ *Malipo Hayakuthibitishwa\\.*\n\n` +
            `Ombi lako la kununua *${escapeMarkdown(productNames)}* haukuthibitishwa\\.\n\n` +
            `Tafadhali hakikisha umetuma pesa sahihi kwa nambari sahihi kisha tuma screenshot tena, au wasiliana na msaada wetu\\.`
          : `❌ *Payment Not Confirmed\\.*\n\n` +
            `Your payment for *${escapeMarkdown(productNames)}* could not be confirmed\\.\n\n` +
            `Please ensure you sent the correct amount to the correct number and try again, or contact our support team\\.`

        await ctx.telegram.sendMessage(Number(order.user.telegramId), rejectMsg, { parse_mode: 'MarkdownV2' }).catch(() => {})
      }

    } catch (err) {
      logger.error('Failed to process mobile money approval', { error: err.message, orderId })
      await ctx.reply(`❌ Hitilafu: ${err.message}`)
    }
  })
}


// ─── Coupon Handlers ─────────────────────────────────────────

function registerCouponHandlers(bot) {
  const { adminGetCoupons, createCoupon, toggleCoupon } = require('../services/referralService')
  const { auditLog } = require('../middlewares/auth')

  // Orodha ya coupons
  bot.action('admin:coupons', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const coupons = await adminGetCoupons()

    if (coupons.length === 0) {
      await ctx.editMessageText(
        '🎟️ *Coupons*\n\nHakuna coupon bado\\.',
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Unda Coupon', 'admin:coupon:add')],
            [Markup.button.callback('◀️ Rudi', 'admin:menu')],
          ]),
        }
      )
      return
    }

    let text = '🎟️ *Coupons Zote:*\n\n'
    for (const c of coupons) {
      const status = c.isActive ? '✅' : '❌'
      const used = `${c.usedCount}${c.usageLimit ? `/${c.usageLimit}` : ''}`
      text += `${status} \`${escapeMarkdown(c.code)}\` — ${c.discountValue}${c.discountType === 'percentage' ? '%' : '⭐'} — Imetumika: ${used}\n`
    }

    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Unda Coupon', 'admin:coupon:add')],
        [Markup.button.callback('◀️ Rudi', 'admin:menu')],
      ]),
    })
  })

  // Anza wizard ya kuunda coupon
  bot.action('admin:coupon:add', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    ctx.session.adminWizard = { scene: 'couponCreate', step: 'code', data: {} }

    await ctx.editMessageText(
      '🎟️ *Unda Coupon Mpya*\n\nAndika code ya coupon \\(herufi na nambari tu, mfano: SAVE20\\):',
      { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:coupons')]]) }
    )
  })

  // Toggle coupon
  bot.action(/^admin:coupon:toggle:(\d+)$/, isAdmin, async (ctx) => {
    const couponId = parseInt(ctx.match[1])
    const coupon = await toggleCoupon(couponId)
    await auditLog(ctx.from.id, 'coupon.toggled', { couponId, isActive: coupon.isActive })
    await ctx.answerCbQuery(coupon.isActive ? '✅ Coupon imewashwa' : '❌ Coupon imezimwa')
    // Refresh orodha
    ctx.callbackQuery.data = 'admin:coupons'
    await bot.handleUpdate({ callback_query: ctx.callbackQuery })
  })
}

// ─── Broadcast Handlers ───────────────────────────────────────

function registerBroadcastHandlers(bot) {
  const { broadcastMessage } = require('../services/notificationService')
  const { auditLog } = require('../middlewares/auth')

  bot.action('admin:broadcast', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    ctx.session.adminWizard = { scene: 'broadcast', step: 'target', data: {} }

    await ctx.editMessageText(
      '📣 *Broadcast Message*\n\nTuma kwa nani?',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👥 Wateja Wote', 'admin:broadcast:all')],
          [Markup.button.callback('🛍️ Waliowahi Kununua', 'admin:broadcast:buyers')],
          [Markup.button.callback('◀️ Rudi', 'admin:menu')],
        ]),
      }
    )
  })

  for (const target of ['all', 'buyers']) {
    bot.action(`admin:broadcast:${target}`, isAdmin, async (ctx) => {
      await ctx.answerCbQuery()
      ctx.session.adminWizard = {
        scene: 'broadcast',
        step: 'message',
        data: { target },
      }

      await ctx.editMessageText(
        `📣 *Broadcast — ${target === 'all' ? 'Wote' : 'Waliowahi Kununua'}*\n\n` +
        `Andika ujumbe unaotaka kutuma:\n` +
        `_\\(Unaweza kutumia MarkdownV2 formatting\\)_`,
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:broadcast')]]),
        }
      )
    })
  }
}

module.exports = {
  registerAdminRouter,
  showAdminMenu,
  backToAdminMenuButton,
}
