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

    // Angalia kama ni claim ya gift (mfano: gift_ABC12)
    if (args.startsWith('gift_')) {
      const code = args.substring(5)
      const { processGiftClaim } = require('../services/giftService')
      return await processGiftClaim(ctx, code)
    }

    // Angalia kama anatoka kwenye channel link (mfano: prod_123)
    if (args.startsWith('prod_')) {
      const productId = parseInt(args.substring(5), 10)
      if (!isNaN(productId)) {
        const { showProductDetail } = require('./browse')
        return showProductDetail(ctx, productId, ctx.session?.language || 'sw')
      }
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

  // ─── Notifications Toggle ───────────────────────────────────
  bot.action('store:notify:toggle', async (ctx) => {
    await ctx.answerCbQuery()
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) }
    })
    if (!user) return
    
    await prisma.user.update({
      where: { id: user.id },
      data: { wantsNotifications: !user.wantsNotifications }
    })
    await showProfile(ctx)
  })

  // ─── Daily Free Drop ────────────────────────────────────────
  bot.command('freedrop', async (ctx) => {
    await handleFreeDrop(ctx)
  })

  bot.action('store:freedrop', async (ctx) => {
    await ctx.answerCbQuery()
    await handleFreeDrop(ctx)
  })

  // ─── About / Trust Score ────────────────────────────────────
  bot.command('about', async (ctx) => {
    await showAbout(ctx)
  })

  bot.action('store:about', async (ctx) => {
    await ctx.answerCbQuery()
    await showAbout(ctx)
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

  const { registerWalletHandlers } = require('./wallet')
  registerWalletHandlers(bot)
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
          Markup.button.callback('🛍️ Bidhaa', 'store:browse'),
          Markup.button.callback('🔜 Oda za Mapema', 'store:preorders'),
        ],
        [
          Markup.button.callback('💰 Wallet Yangu', 'store:wallet'),
          Markup.button.callback('📦 Maagizo Yangu', 'store:orders'),
        ],
        [
          Markup.button.callback('💬 Msaada', 'store:support'),
          Markup.button.callback('👑 VIP', 'store:vip:join_init'),
        ],
        [
          Markup.button.callback('🔄 Omba Refund', 'store:refund:menu'),
          Markup.button.callback('ℹ️ Kuhusu Sisi', 'store:about'),
        ],
        [
          Markup.button.callback('🎁 Zawadi ya Leo', 'store:freedrop'),
          Markup.button.callback('🌐 Lugha (Language)', 'store:language'),
        ],
      ])
    : Markup.inlineKeyboard([
        [
          Markup.button.callback('🛍️ Products', 'store:browse'),
          Markup.button.callback('🔜 Pre-Orders', 'store:preorders'),
        ],
        [
          Markup.button.callback('💰 Wallet', 'store:wallet'),
          Markup.button.callback('📦 My Orders', 'store:orders'),
        ],
        [
          Markup.button.callback('💬 Support', 'store:support'),
          Markup.button.callback('👑 VIP', 'store:vip:join_init'),
        ],
        [
          Markup.button.callback('🔄 Refund Request', 'store:refund:menu'),
          Markup.button.callback('ℹ️ About Us', 'store:about'),
        ],
        [
          Markup.button.callback('🎁 Daily Drop', 'store:freedrop'),
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

  // Angalia kama muda wa VIP umeisha
  const { checkVipExpiry } = require('../services/vipService')
  await checkVipExpiry(user.id).catch(() => {})

  const updatedUser = await prisma.user.findUnique({
    where: { id: user.id },
    include: {
      _count: { select: { orders: true, referred: true } },
    },
  })

  const paidOrders = await prisma.order.count({
    where: { userId: updatedUser.id, status: { in: ['paid', 'delivered'] } },
  })

  const botUsername = (await ctx.telegram.getMe()).username

  const vipStatusSw = updatedUser.isVip
    ? `👑 *Uanachama:* VIP \\(Inaisha: ${escapeMarkdown(updatedUser.vipExpiresAt.toLocaleDateString('sw-TZ'))}\\)`
    : `👤 *Uanachama:* Kawaida`

  const vipStatusEn = updatedUser.isVip
    ? `👑 *Membership:* VIP \\(Expires: ${escapeMarkdown(updatedUser.vipExpiresAt.toLocaleDateString('en-US'))}\\)`
    : `👤 *Membership:* Standard`

  const text = lang === 'sw'
    ? [
        `👤 *Wasifu Wako*`,
        ``,
        `🆔 ID: \`${updatedUser.telegramId}\``,
        `📛 Jina: ${escapeMarkdown(updatedUser.fullName || updatedUser.username || 'Bila jina')}`,
        vipStatusSw,
        ``,
        `📊 *Takwimu Zangu:*`,
        `🛍️ Ununuzi: ${paidOrders}`,
        `💰 Komisheni ya Referral: TZS ${updatedUser.commissionEarned.toLocaleString('en-US')}`,
        `👥 Walioalikwa: ${updatedUser._count.referred}`,
        ``,
        `🔗 *Link Yangu ya Referral:*`,
        `\`https://t\\.me/${botUsername}?start=ref_${updatedUser.referralCode}\``,
        ``,
        `_Shiriki link hii\\. Kila mtu anayenunua kupitia link yako, utapata TZS ${config.referral.commissionTzs.toLocaleString('en-US')} kwenye wallet yako\\!_`,
      ].join('\n')
    : [
        `👤 *My Profile*`,
        ``,
        `🆔 ID: \`${updatedUser.telegramId}\``,
        `📛 Name: ${escapeMarkdown(updatedUser.fullName || updatedUser.username || 'No name')}`,
        vipStatusEn,
        ``,
        `📊 *My Stats:*`,
        `🛍️ Purchases: ${paidOrders}`,
        `💰 Referral Commission: TZS ${updatedUser.commissionEarned.toLocaleString('en-US')}`,
        `👥 Referred Users: ${updatedUser._count.referred}`,
        ``,
        `🔗 *My Referral Link:*`,
        `\`https://t\\.me/${botUsername}?start=ref_${updatedUser.referralCode}\``,
        ``,
        `_Share this link\\. Every purchase earns you TZS ${config.referral.commissionTzs.toLocaleString('en-US')} in your wallet\\!_`,
      ].join('\n')

  const vipBtnLabel = updatedUser.isVip
    ? (lang === 'sw' ? '👑 Ongeza Muda wa VIP' : '👑 Extend VIP')
    : (lang === 'sw' ? '👑 Jiunge na VIP' : '👑 Join VIP')

  const notifyBtnLabel = updatedUser.wantsNotifications
    ? (lang === 'sw' ? '🔕 Zima Notifications' : '🔕 Turn Off Notifications')
    : (lang === 'sw' ? '🔔 Washa Notifications' : '🔔 Turn On Notifications')

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(lang === 'sw' ? '💳 Wallet Yangu' : '💳 My Wallet', 'store:wallet'),
      Markup.button.callback(vipBtnLabel, 'store:vip:join_init'),
    ],
    [
      Markup.button.callback(notifyBtnLabel, 'store:notify:toggle'),
    ],
    [
      Markup.button.callback(lang === 'sw' ? '◀️ Rudi Nyumbani' : '◀️ Back to Menu', 'store:menu')
    ],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

// ─── Daily Free Drop Logic ────────────────────────────────────

async function handleFreeDrop(ctx) {
  const lang = ctx.session?.language || 'sw'
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) }
  })

  if (!user) {
    return ctx.reply(lang === 'sw' ? 'Tafadhali anza kwa /start' : 'Please start with /start')
  }

  const now = new Date()
  
  if (user.lastFreeDropAt) {
    const diffHours = (now - user.lastFreeDropAt) / (1000 * 60 * 60)
    if (diffHours < 24) {
      const remaining = Math.ceil(24 - diffHours)
      const text = lang === 'sw'
        ? `⏳ Umeshachukua zawadi yako ya leo\\! Rudi tena baada ya masaa ${remaining} kupata nyingine\\.`
        : `⏳ You already claimed today's free drop\\! Come back in ${remaining} hours for the next one\\.`
        
      if (ctx.callbackQuery) {
        return ctx.editMessageText(text, {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')]])
        })
      }
      return ctx.reply(text, { parse_mode: 'MarkdownV2' })
    }
  }

  // Toa zawadi (Hapa tunatumia random tips, unaweza kubadilisha hapo baadaye kwa kuwa na table maalum)
  const tipsSw = [
    '💡 *Tip ya Leo:* Kila siku unapojifunza kitu kipya, unajiweka kwenye nafasi nzuri ya kufanikiwa.',
    '💡 *Tip ya Leo:* Kutunza kumbukumbu ya mauzo ni siri kubwa ya ukuaji wa biashara yoyote.',
    '💡 *Tip ya Leo:* Wateja wanapenda mawasiliano mazuri kuliko hata punguzo la bei.',
    '💡 *Tip ya Leo:* Wekeza kwenye elimu yako, ndio uwekezaji usioshuka thamani.'
  ]
  const tipsEn = [
    '💡 *Today\'s Tip:* Every day you learn something new, you position yourself for success.',
    '💡 *Today\'s Tip:* Keeping track of sales is the big secret to any business growth.',
    '💡 *Today\'s Tip:* Customers love good communication even more than price discounts.',
    '💡 *Today\'s Tip:* Invest in your education, it\'s the only investment that never depreciates.'
  ]

  const randomIndex = Math.floor(Math.random() * tipsSw.length)
  const tip = lang === 'sw' ? tipsSw[randomIndex] : tipsEn[randomIndex]

  await prisma.user.update({
    where: { id: user.id },
    data: { lastFreeDropAt: now }
  })

  const text = lang === 'sw'
    ? `🎁 *Zawadi Yako ya Leo Imefika!*\n\n${escapeMarkdown(tip)}\n\n_Usikose zawadi nyingine kesho muda kama huu!_`
    : `🎁 *Your Daily Drop is Here!*\n\n${escapeMarkdown(tip)}\n\n_Don't miss another drop tomorrow at this time!_`

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Bidhaa Zetu' : '🛍️ Browse Products', 'store:browse')],
    [Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')]
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

module.exports = { registerStoreRouter, showMainMenu }
