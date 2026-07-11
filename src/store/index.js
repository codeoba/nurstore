'use strict'

const { Markup } = require('telegraf')
const { escapeMarkdown } = require('../utils/formatting')
const { prisma } = require('../database')
const { getSetting } = require('../admin/settings')
const { processReferral } = require('../services/referralService')
const { generateReferralCode } = require('../middlewares/auth')
const config = require('../config')

/**
 * Register user store handlers
 * @param {import('telegraf').Telegraf} bot
 */
function registerStoreRouter(bot) {
  // ─── /start ────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1).join(' ')

    // Angalia kama ana referral code
    if (args.startsWith('ref_')) {
      const refCode = args.substring(4)
      await processReferral(ctx.from.id, refCode)
    }

    await showMainMenu(ctx)
  })

  // ─── Main Menu ─────────────────────────────────────────────
  bot.action('store:menu', async (ctx) => {
    await ctx.answerCbQuery()
    await showMainMenu(ctx)
  })

  // ─── My Profile / Referral ──────────────────────────────────
  bot.command('profile', async (ctx) => {
    await showProfile(ctx)
  })

  bot.action('store:profile', async (ctx) => {
    await ctx.answerCbQuery()
    await showProfile(ctx)
  })

  // ─── Language Selection ─────────────────────────────────────
  bot.action('store:language', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session.language || 'sw'

    await ctx.editMessageText(
      '🌐 *Chagua Lugha / Choose Language*',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(lang === 'sw' ? '✅ 🇹🇿 Kiswahili' : '🇹🇿 Kiswahili', 'store:lang:sw'),
            Markup.button.callback(lang === 'en' ? '✅ 🇺🇸 English' : '🇺🇸 English', 'store:lang:en'),
          ],
          [Markup.button.callback('◀️ Rudi', 'store:menu')],
        ]),
      }
    )
  })

  bot.action(/^store:lang:(sw|en)$/, async (ctx) => {
    const lang = ctx.match[1]
    ctx.session.language = lang

    // Hifadhi kwenye database pia
    await prisma.user.updateMany({
      where: { telegramId: BigInt(ctx.from.id) },
      data: { language: lang },
    }).catch(() => {})

    await ctx.answerCbQuery(lang === 'sw' ? '✅ Kiswahili imechaguliwa' : '✅ English selected')
    await showMainMenu(ctx)
  })

  // Register sub-modules
  const { registerBrowseHandlers } = require('./browse')
  registerBrowseHandlers(bot)

  const { registerCartHandlers } = require('./cart')
  registerCartHandlers(bot)

  const { registerCheckoutHandlers } = require('./checkout')
  registerCheckoutHandlers(bot)

  const { registerOrdersHandlers } = require('./orders')
  registerOrdersHandlers(bot)

  const { registerSupportHandlers } = require('./support')
  registerSupportHandlers(bot)
}

// ─── Main Menu Display ────────────────────────────────────────

async function showMainMenu(ctx) {
  const lang = ctx.session?.language || 'sw'
  const from = ctx.from
  const name = escapeMarkdown(from.first_name || 'Mgeni')

  // Pata welcome message kutoka settings au tumia default
  const customWelcome = await getSetting('welcome_message').catch(() => null)

  const storeName = escapeMarkdown(config.bot.storeName)

  const text = customWelcome
    ? escapeMarkdown(customWelcome)
    : lang === 'sw'
      ? `🛍️ *Karibu ${name} katika ${storeName}\\!*\n\nTuna bidhaa za dijiti bora kwa bei nafuu\\. Chagua chaguo lako:` 
      : `🛍️ *Welcome ${name} to ${storeName}\\!*\n\nWe have quality digital products at great prices\\. Choose your option:`

  const keyboard = lang === 'sw'
    ? Markup.inlineKeyboard([
        [
          Markup.button.callback('🛍️ Angalia Bidhaa', 'store:browse'),
          Markup.button.callback('🔍 Tafuta', 'store:search'),
        ],
        [
          Markup.button.callback('🛒 Kikapu Changu', 'store:cart'),
          Markup.button.callback('📦 Maagizo Yangu', 'store:orders'),
        ],
        [
          Markup.button.callback('❤️ Vipendwa', 'store:wishlist'),
          Markup.button.callback('👤 Wasifu Wangu', 'store:profile'),
        ],
        [
          Markup.button.callback('💬 Msaada', 'store:support'),
          Markup.button.callback('🌐 Lugha', 'store:language'),
        ],
      ])
    : Markup.inlineKeyboard([
        [
          Markup.button.callback('🛍️ Browse Products', 'store:browse'),
          Markup.button.callback('🔍 Search', 'store:search'),
        ],
        [
          Markup.button.callback('🛒 My Cart', 'store:cart'),
          Markup.button.callback('📦 My Orders', 'store:orders'),
        ],
        [
          Markup.button.callback('❤️ Wishlist', 'store:wishlist'),
          Markup.button.callback('👤 My Profile', 'store:profile'),
        ],
        [
          Markup.button.callback('💬 Support', 'store:support'),
          Markup.button.callback('🌐 Language', 'store:language'),
        ],
      ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

// ─── Profile ──────────────────────────────────────────────────

async function showProfile(ctx) {
  const lang = ctx.session?.language || 'sw'
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    include: {
      _count: { select: { orders: true, referred: true } },
    },
  })

  if (!user) {
    await ctx.reply(lang === 'sw' ? 'Tafadhali anza kwa /start' : 'Please start with /start')
    return
  }

  const paidOrders = await prisma.order.count({
    where: { userId: user.id, status: { in: ['paid', 'delivered'] } },
  })

  const botUsername = (await ctx.telegram.getMe()).username

  const text = lang === 'sw'
    ? [
        `👤 *Wasifu Wako*`,
        ``,
        `🆔 ID: \`${user.telegramId}\``,
        `📛 Jina: ${escapeMarkdown(user.fullName || user.username || 'Bila jina')}`,
        ``,
        `📊 *Takwimu Zangu:*`,
        `🛍️ Ununuzi: ${paidOrders}`,
        `⭐ Stars za Referral: ${user.starsEarned}`,
        `👥 Walioalikwa: ${user._count.referred}`,
        ``,
        `🔗 *Link Yangu ya Referral:*`,
        `\`https://t\\.me/${botUsername}?start=ref_${user.referralCode}\``,
        ``,
        `_Shiriki link hii\\. Kila mtu anayenunua kupitia link yako, utapata ⭐${config.referral.commissionStars} Stars\\!_`,
      ].join('\n')
    : [
        `👤 *My Profile*`,
        ``,
        `🆔 ID: \`${user.telegramId}\``,
        `📛 Name: ${escapeMarkdown(user.fullName || user.username || 'No name')}`,
        ``,
        `📊 *My Stats:*`,
        `🛍️ Purchases: ${paidOrders}`,
        `⭐ Referral Stars: ${user.starsEarned}`,
        `👥 Referred Users: ${user._count.referred}`,
        ``,
        `🔗 *My Referral Link:*`,
        `\`https://t\\.me/${botUsername}?start=ref_${user.referralCode}\``,
        ``,
        `_Share this link\\. Every purchase earns you ⭐${config.referral.commissionStars} Stars\\!_`,
      ].join('\n')

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'sw' ? '◀️ Rudi Nyumbani' : '◀️ Back to Menu', 'store:menu')],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

module.exports = { registerStoreRouter, showMainMenu }
