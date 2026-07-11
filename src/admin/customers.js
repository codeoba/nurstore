'use strict'

const { Markup } = require('telegraf')
const { isAdmin, auditLog } = require('../middlewares/auth')
const { escapeMarkdown } = require('../utils/formatting')
const { prisma } = require('../database')
const { broadcastMessage } = require('../services/notificationService')
const logger = require('../utils/logger')

function registerAdminCustomerHandlers(bot) {
  // ─── Customers List ──────────────────────────────────────────
  bot.action(/^admin:customers(:page:(\d+))?$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const page = parseInt(ctx.match[2] || '1')
    await showCustomersList(ctx, page)
  })

  // ─── View Customer ────────────────────────────────────────────
  bot.action(/^admin:customer:view:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const userId = parseInt(ctx.match[1])
    await showCustomerDetail(ctx, userId)
  })

  // ─── Block / Unblock ──────────────────────────────────────────
  bot.action(/^admin:customer:(block|unblock):(\d+)$/, isAdmin, async (ctx) => {
    const action = ctx.match[1]
    const userId = parseInt(ctx.match[2])
    const block = action === 'block'

    await prisma.user.update({
      where: { id: userId },
      data: { isBlocked: block },
    })

    await auditLog(ctx.from.id, `user.${action}`, { userId })
    await ctx.answerCbQuery(block ? '🚫 Mtumiaji amezuiwa' : '✅ Mtumiaji amefunguliwa')
    await showCustomerDetail(ctx, userId)
  })

  // ─── Message Customer ─────────────────────────────────────────
  bot.action(/^admin:customer:message:(\d+)$/, isAdmin, async (ctx) => {
    const userId = parseInt(ctx.match[1])
    await ctx.answerCbQuery()

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    })

    if (!user) {
      await ctx.answerCbQuery('Mtumiaji haipatikani', { show_alert: true })
      return
    }

    ctx.session.adminWizard = {
      scene: 'sendMessage',
      step: 'message',
      data: { targetTelegramId: Number(user.telegramId) },
    }

    await ctx.editMessageText(
      '💬 *Tuma Ujumbe kwa Mteja*\n\nAndika ujumbe unaotaka kutuma:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', `admin:customer:view:${userId}`)]]),
      }
    )
  })

  // ─── Search Customer ──────────────────────────────────────────
  bot.action('admin:customers:search', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    ctx.session.adminWizard = { scene: 'searchCustomer', step: 'query', data: {} }
    await ctx.editMessageText(
      '🔍 *Tafuta Mteja*\n\nAndika username, jina, au Telegram ID:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Ghairi', 'admin:customers')]]),
      }
    )
  })
}

// ─── Customer Wizard Handler ──────────────────────────────────

async function handleAdminCustomerWizard(ctx) {
  const wizard = ctx.session?.adminWizard
  if (!wizard) return false

  const text = ctx.message?.text?.trim()

  if (wizard.scene === 'sendMessage' && wizard.step === 'message') {
    try {
      await ctx.telegram.sendMessage(wizard.data.targetTelegramId, text)
      ctx.session.adminWizard = null
      await ctx.reply('✅ Ujumbe umetumwa kwa mteja.')
    } catch (err) {
      await ctx.reply(`❌ Hitilafu kutuma ujumbe: ${err.message}`)
    }
    return true
  }

  if (wizard.scene === 'searchCustomer' && wizard.step === 'query') {
    ctx.session.adminWizard = null
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: text, mode: 'insensitive' } },
          { fullName: { contains: text, mode: 'insensitive' } },
          ...(isNaN(parseInt(text)) ? [] : [{ telegramId: BigInt(parseInt(text)) }]),
        ],
      },
      take: 5,
      include: { _count: { select: { orders: true } } },
    })

    if (users.length === 0) {
      await ctx.reply('🔍 Hakuna mteja aliyepatikana.')
      return true
    }

    const buttons = users.map(u => [
      Markup.button.callback(
        `${u.fullName || u.username || u.telegramId.toString()} (${u._count.orders} orders)`,
        `admin:customer:view:${u.id}`
      )
    ])
    buttons.push([Markup.button.callback('◀️ Wateja', 'admin:customers')])

    await ctx.reply('🔍 *Matokeo ya Utafutaji:*', {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
    })
    return true
  }

  return false
}

// ─── Display Functions ────────────────────────────────────────

async function showCustomersList(ctx, page = 1) {
  const limit = 10
  const skip = (page - 1) * limit

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { orders: true } } },
    }),
    prisma.user.count(),
  ])

  let text = `👥 *Wateja \\(${total}\\):*\n\n`
  for (const u of users) {
    const blocked = u.isBlocked ? '🚫' : '✅'
    const name = u.username ? `@${u.username}` : u.fullName || String(u.telegramId)
    text += `${blocked} ${escapeMarkdown(name)} — ${u._count.orders} maagizo\n`
  }

  const totalPages = Math.ceil(total / limit)
  text += `\n📄 Ukurasa ${page}/${totalPages}`

  const userButtons = users.map(u => [
    Markup.button.callback(
      `${u.isBlocked ? '🚫' : ''}${(u.username || u.fullName || String(u.telegramId)).substring(0, 25)}`,
      `admin:customer:view:${u.id}`
    )
  ])

  const navButtons = []
  if (page > 1) navButtons.push(Markup.button.callback('◀️', `admin:customers:page:${page - 1}`))
  if (page < totalPages) navButtons.push(Markup.button.callback('▶️', `admin:customers:page:${page + 1}`))
  if (navButtons.length) userButtons.push(navButtons)

  userButtons.push([Markup.button.callback('🔍 Tafuta', 'admin:customers:search')])
  userButtons.push([Markup.button.callback('◀️ Rudi', 'admin:menu')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(userButtons) })
}

async function showCustomerDetail(ctx, userId) {
  const { getOrCreateWallet } = require('../services/walletService')

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      _count: { select: { orders: true, reviews: true } },
      orders: {
        where: { status: { in: ['paid', 'delivered'] } },
        select: { totalTzs: true },
      },
    },
  })

  if (!user) {
    await ctx.editMessageText('❌ Mteja haipatikani.')
    return
  }

  const wallet = await getOrCreateWallet(user.id)
  const totalSpent = user.orders.reduce((sum, o) => sum + o.totalTzs, 0)
  const status = user.isBlocked ? '🚫 Amezuiwa' : '✅ Anafanya kazi'

  let text = [
    `👤 *Mteja: ${escapeMarkdown(user.fullName || user.username || String(user.telegramId))}*`,
    ``,
    `🆔 Telegram ID: \`${user.telegramId}\``,
    user.username ? `📛 Username: @${escapeMarkdown(user.username)}` : '',
    `📅 Alijisajili: ${escapeMarkdown(new Date(user.createdAt).toLocaleDateString('sw-TZ'))}`,
    `🌐 Lugha: ${user.language === 'sw' ? '🇹🇿 Kiswahili' : '🇺🇸 English'}`,
    ``,
    `📊 *Takwimu:*`,
    `🛍️ Maagizo yote: ${user._count.orders}`,
    `💫 Jumla aliyotumia: TZS ${totalSpent.toLocaleString('en-US')}`,
    `💳 Salio la Wallet: TZS ${wallet.balance.toLocaleString('en-US')}`,
    `💰 Komisheni ya referral: TZS ${user.commissionEarned.toLocaleString('en-US')}`,
    `📝 Reviews: ${user._count.reviews}`,
    ``,
    `📊 Hali: ${status}`,
  ].filter(Boolean).join('\n')

  const buttons = [
    [
      Markup.button.callback('💬 Tuma Ujumbe', `admin:customer:message:${userId}`),
    ],
    [
      user.isBlocked
        ? Markup.button.callback('✅ Fungua', `admin:customer:unblock:${userId}`)
        : Markup.button.callback('🚫 Zuia', `admin:customer:block:${userId}`),
    ],
    [Markup.button.callback('◀️ Wateja', 'admin:customers')],
  ]

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) })
}

module.exports = { registerAdminCustomerHandlers, handleAdminCustomerWizard }
