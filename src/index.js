'use strict'

// ─── Load environment variables ───────────────────────────────
require('dotenv').config()

const { Telegraf, session } = require('telegraf')
const { Redis } = require('ioredis')
const config = require('./config')
const { prisma } = require('./database')
const logger = require('./utils/logger')
const { attachUser, isSuperAdmin } = require('./middlewares/auth')
const { apiRateLimit } = require('./middlewares/rateLimit')
const { redisSession } = require('./middlewares/session')

// ─── Handlers & Routers ───────────────────────────────────────
const { registerAdminRouter } = require('./admin')
const { registerStoreRouter } = require('./store')
const { handlePreCheckout, handleSuccessfulPayment } = require('./payments/telegramPayments')

// ─── Admin Wizards ────────────────────────────────────────────
const { handleAdminProductWizard } = require('./admin/products')
const { handleAdminCustomerWizard } = require('./admin/customers')
const { handleAdminSettingsWizard } = require('./admin/settings')

// ─── Store Wizards ────────────────────────────────────────────
const { handleSearchQuery } = require('./store/browse')
const { handleCheckoutWizard } = require('./store/checkout')
const { handleReviewWizard } = require('./store/orders')
const { handleSupportWizard, handleAdminTicketReply } = require('./store/support')
const { handleWalletDepositWizard } = require('./store/wallet')

// ─── Background Jobs ──────────────────────────────────────────
const { startJobWorkers, scheduleRecurringJobs } = require('./jobs')
const { getSetting } = require('./admin/settings')

// ─── Bot Instance ─────────────────────────────────────────────
const bot = new Telegraf(config.bot.token)

// ─── Redis Client ─────────────────────────────────────────────
const redis = new Redis(config.redis.url)

redis.on('error', (err) => {
  logger.error('Redis connection error', { error: err.message })
})

redis.on('connect', () => {
  logger.info('✅ Redis connected')
})

// ─── Global Middlewares ───────────────────────────────────────

// 1. Session (Redis-backed)
bot.use(redisSession(redis))

// 2. Rate limiting (global)
bot.use(apiRateLimit)

// 3. Attach user to context (auto-register new users)
bot.use(attachUser)

// 4. Maintenance mode check
bot.use(async (ctx, next) => {
  // Admin anaweza kupita maintenance mode
  if (ctx.isSuperAdmin) return next()

  const maintenance = await getSetting('maintenance_mode').catch(() => null)
  if (maintenance === 'true') {
    const lang = ctx.session?.language || 'sw'
    const msg = lang === 'sw'
      ? '🔧 Bot iko kwenye matengenezo. Jaribu tena baadaye.'
      : '🔧 Bot is under maintenance. Please try again later.'

    if (ctx.message) await ctx.reply(msg)
    else if (ctx.callbackQuery) await ctx.answerCbQuery(msg, { show_alert: true })
    return
  }

  return next()
})

// 5. Mark admins on context
bot.use(isSuperAdmin)

// ─── Register All Handlers ────────────────────────────────────

// Admin Panel
registerAdminRouter(bot)

// User Store
registerStoreRouter(bot)

// ─── Payment Handlers ─────────────────────────────────────────

bot.on('pre_checkout_query', handlePreCheckout)
bot.on('successful_payment', handleSuccessfulPayment)

// ─── Universal Message Handler ────────────────────────────────
// Inachukua maandishi ya kawaida na kuyapeleka kwa wizard sahihi

bot.on('message', async (ctx) => {
  const wizard = ctx.session?.adminWizard
  const userWizard = ctx.session?.userWizard

  // ─── Admin Wizards ───────────────────────────────────────────
  if (wizard) {
    // Broadcast wizard (message text)
    if (wizard.scene === 'broadcast' && wizard.step === 'message') {
      const { broadcastMessage } = require('./services/notificationService')
      const { auditLog } = require('./middlewares/auth')

      const msg = ctx.message.text
      if (!msg) {
        await ctx.reply('⚠️ Tafadhali tuma ujumbe wa maandishi.')
        return
      }

      ctx.session.adminWizard = null
      const target = wizard.data.target || 'all'
      const filters = target === 'buyers' ? { hasPurchased: true } : {}

      await ctx.reply('📣 Inatuma...')

      const result = await broadcastMessage(ctx.telegram, msg, filters)
      await auditLog(ctx.from.id, 'broadcast.sent', { target, ...result })

      await ctx.reply(`✅ Broadcast imekamilika!\n📤 Imetumwa: ${result.sent}\n❌ Imeshindwa: ${result.failed}`)
      return
    }

    // Coupon create wizard
    if (wizard.scene === 'couponCreate') {
      await handleCouponCreateWizard(ctx, wizard)
      return
    }

    // Reply to ticket (admin)
    if (wizard.scene === 'replyTicket') {
      const handled = await handleAdminTicketReply(ctx)
      if (handled) return
    }

    // Add admin role (handled by callback, skip here)

    // Product wizard
    const handled = await handleAdminProductWizard(ctx)
    if (handled) return

    // Customer wizard
    const custHandled = await handleAdminCustomerWizard(ctx)
    if (custHandled) return

    // Settings wizard
    const settHandled = await handleAdminSettingsWizard(ctx)
    if (settHandled) return
  }

  // ─── User Wizards ─────────────────────────────────────────────
  if (userWizard) {
    // Search
    if (userWizard.scene === 'search') {
      const handled = await handleSearchQuery(ctx)
      if (handled) return
    }

    // Checkout coupon
    if (['checkout', 'directBuyCoupon'].includes(userWizard.scene)) {
      const handled = await handleCheckoutWizard(ctx)
      if (handled) return
    }

    // Review
    if (userWizard.scene === 'review') {
      const handled = await handleReviewWizard(ctx)
      if (handled) return
    }

    // Mobile Money Proof
    if (userWizard.scene === 'mobilemoney_proof') {
      const { handleMobileMoneyWizard } = require('./store/checkout')
      const handled = await handleMobileMoneyWizard(ctx)
      if (handled) return
    }

    // Refund
    if (userWizard.scene === 'refund') {
      const { handleRefundWizard } = require('./store/orders')
      const handled = await handleRefundWizard(ctx)
      if (handled) return
    }

    // Support ticket
    if (userWizard.scene === 'support') {
      const handled = await handleSupportWizard(ctx)
      if (handled) return
    }

    // Wallet deposit
    if (userWizard.scene === 'wallet_deposit') {
      const handled = await handleWalletDepositWizard(ctx)
      if (handled) return
    }
  }

  // ─── Fallback ─────────────────────────────────────────────────
  // Kama hakuna wizard inayoshughulikia, onyesha help
  const lang = ctx.session?.language || 'sw'
  const helpText = lang === 'sw'
    ? '❓ Sijui amri hiyo\\. Tumia /start kurudi kwenye menyu kuu\\.'
    : '❓ I don\'t understand that command\\. Use /start to return to the main menu\\.'

  await ctx.reply(helpText, { parse_mode: 'MarkdownV2' })
})

// ─── Error Handler ────────────────────────────────────────────

bot.catch((err, ctx) => {
  logger.error('Unhandled bot error', {
    error: err.message,
    stack: err.stack,
    updateType: ctx?.updateType,
    userId: ctx?.from?.id,
  })

  // Jaribu kutuma error message kwa mtumiaji
  const lang = ctx?.session?.language || 'sw'
  const errorMsg = lang === 'sw'
    ? '😔 Hitilafu imejitokeza\\. Tafadhali jaribu tena baadaye\\.'
    : '😔 An error occurred\\. Please try again later\\.'

  if (ctx?.reply) {
    ctx.reply(errorMsg, { parse_mode: 'MarkdownV2' }).catch(() => {})
  }
})

// ─── Coupon Create Wizard ─────────────────────────────────────

async function handleCouponCreateWizard(ctx, wizard) {
  const { createCoupon } = require('./services/referralService')
  const { auditLog } = require('./middlewares/auth')
  const text = ctx.message?.text?.trim()
  const { parseNumber } = require('./utils/validation')

  switch (wizard.step) {
    case 'code': {
      if (!/^[A-Z0-9]{3,20}$/.test(text?.toUpperCase())) {
        await ctx.reply('⚠️ Code lazima iwe na herufi 3-20, A-Z na 0-9 tu. Jaribu tena:')
        return
      }
      wizard.data.code = text.toUpperCase()
      wizard.step = 'type'
      await ctx.reply(
        '✅ Code: ' + wizard.data.code + '\n\nChagua aina ya punguzo:',
        require('telegraf').Markup.inlineKeyboard([
          [
            require('telegraf').Markup.button.callback('💫 Stars Fixed', 'admin:wizard:coupon:fixed'),
            require('telegraf').Markup.button.callback('% Percentage', 'admin:wizard:coupon:percentage'),
          ],
        ])
      )
      break
    }
    case 'value': {
      const val = parseNumber(text)
      if (!val || val < 1 || val > 10000) {
        await ctx.reply('⚠️ Andika nambari sahihi kati ya 1 na 10,000:')
        return
      }
      wizard.data.discountValue = val
      wizard.step = 'usage_limit'
      await ctx.reply('✅ Thamani imewekwa.\n\nAndika idadi ya juu ya matumizi (au "unlimited"):')
      break
    }
    case 'usage_limit': {
      const limit = text?.toLowerCase() === 'unlimited' ? null : parseNumber(text)
      wizard.data.usageLimit = limit
      wizard.step = 'min_stars'
      await ctx.reply('Andika bei ya chini ya order kwa Stars (au 0 kwa hakuna mipaka):')
      break
    }
    case 'min_stars': {
      const min = parseNumber(text) || 0
      wizard.data.minStars = min > 0 ? min : null

      // Unda coupon
      ctx.session.adminWizard = null
      try {
        const coupon = await createCoupon(wizard.data)
        await auditLog(ctx.from.id, 'coupon.created', { couponId: coupon.id, code: coupon.code })
        await ctx.reply(`✅ Coupon \`${coupon.code}\` imeundwa!\n\nThamani: ${coupon.discountValue}${coupon.discountType === 'percentage' ? '%' : '⭐'}`)
      } catch (err) {
        await ctx.reply(`❌ Hitilafu: ${err.message}`)
      }
      break
    }
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`)

  try {
    await bot.stop(signal)
    await prisma.$disconnect()
    await redis.disconnect()
    logger.info('✅ Graceful shutdown complete')
    process.exit(0)
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message })
    process.exit(1)
  }
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

// ─── Start Bot ────────────────────────────────────────────────

async function main() {
  logger.info(`🚀 Starting ${config.bot.storeName} Bot...`)
  logger.info(`Environment: ${config.env}`)

  // Thibitisha DB connection
  try {
    await prisma.$connect()
    logger.info('✅ Database connected')
  } catch (err) {
    logger.error('❌ Database connection failed', { error: err.message })
    process.exit(1)
  }

  // Anza background jobs
  try {
    await startJobWorkers(bot)
    await scheduleRecurringJobs()
  } catch (err) {
    logger.warn('Background jobs failed to start', { error: err.message })
    // Endelea hata kama jobs hazifanyi kazi
  }

  // Weka commands za bot kwenye menyu ya Telegram
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Fungua menyu kuu / Open Main Menu' },
      { command: 'profile', description: 'Wasifu na Referral / Profile & Referrals' },
      { command: 'myorders', description: 'Maagizo yangu / My Orders' },
      { command: 'support', description: 'Wasiliana na msaada / Contact Support' },
      { command: 'admin', description: 'Panel ya Wasimamizi / Admin Panel (Admins Only)' },
    ])
    logger.info('✅ Bot commands menu registered')
  } catch (err) {
    logger.warn('Failed to set bot commands menu', { error: err.message })
  }

  // Anza bot kwa polling mode
  await bot.launch({
    allowedUpdates: [
      'message',
      'callback_query',
      'pre_checkout_query',
      'successful_payment',
      'inline_query',
      'shipping_query',
    ],
  })

  logger.info(`✅ ${config.bot.storeName} Bot is running!`)
  logger.info(`🤖 Bot username: @${bot.botInfo?.username}`)
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack })
  process.exit(1)
})
