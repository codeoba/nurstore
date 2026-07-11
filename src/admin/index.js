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
      _sum: { totalStars: true },
    }),
    prisma.product.count({ where: { isActive: true } }),
    prisma.order.count({ where: { status: 'pending' } }),
  ])

  const adminName = escapeMarkdown(ctx.from.first_name || 'Admin')
  const stars = todayRevenue._sum.totalStars || 0

  const text = [
    `👨‍💼 *Admin Panel — ${escapeMarkdown(require('../config').bot.storeName)}*`,
    `Karibu, ${adminName}\\!`,
    ``,
    `📊 *Takwimu za Leo:*`,
    `🛍️ Maagizo: *${todayOrders}*`,
    `💫 Mapato: *⭐ ${stars}*`,
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
  const { registerAdminProductHandlers } = require('./products')
  registerAdminProductHandlers(bot)

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
  const { registerAdminSettingsHandlers } = require('./settings')
  registerAdminSettingsHandlers(bot)

  // ─── Coupons ──────────────────────────────────────────────
  registerCouponHandlers(bot)

  // ─── Broadcast ────────────────────────────────────────────
  registerBroadcastHandlers(bot)
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
