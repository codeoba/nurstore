'use strict'

const { Markup } = require('telegraf')
const { isAdmin } = require('../middlewares/auth')
const { escapeMarkdown, starsToTzs } = require('../utils/formatting')
const { prisma } = require('../database')
const logger = require('../utils/logger')

function registerAdminAnalyticsHandlers(bot) {
  bot.action('admin:analytics', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showAnalyticsDashboard(ctx)
  })

  bot.action('admin:analytics:daily', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showPeriodReport(ctx, 'daily')
  })

  bot.action('admin:analytics:weekly', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showPeriodReport(ctx, 'weekly')
  })

  bot.action('admin:analytics:monthly', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showPeriodReport(ctx, 'monthly')
  })

  bot.action('admin:analytics:top_products', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showTopProducts(ctx)
  })

  bot.action('admin:analytics:revenue', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    await showRevenueReport(ctx)
  })
}

async function showAnalyticsDashboard(ctx) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [todayStats, weekStats, monthStats, totalStats, userStats] = await Promise.all([
    getOrderStats({ gte: today }),
    getOrderStats({ gte: weekAgo }),
    getOrderStats({ gte: monthAgo }),
    getOrderStats({}),
    getUserStats(),
  ])

  const text = [
    `📊 *Analytics Dashboard*`,
    ``,
    `*📅 Leo:*`,
    `  🛍️ Maagizo: ${todayStats.count}`,
    `  💫 Mapato: ⭐ ${todayStats.revenue}`,
    ``,
    `*📅 Wiki Hii \\(siku 7\\):*`,
    `  🛍️ Maagizo: ${weekStats.count}`,
    `  💫 Mapato: ⭐ ${weekStats.revenue} \\(${starsToTzs(weekStats.revenue)}\\)`,
    ``,
    `*📅 Mwezi Huu \\(siku 30\\):*`,
    `  🛍️ Maagizo: ${monthStats.count}`,
    `  💫 Mapato: ⭐ ${monthStats.revenue} \\(${starsToTzs(monthStats.revenue)}\\)`,
    ``,
    `*📊 Jumla Yote:*`,
    `  🛍️ Maagizo: ${totalStats.count}`,
    `  💫 Mapato: ⭐ ${totalStats.revenue}`,
    `  ❌ Zilizoshindwa: ${totalStats.failed}`,
    ``,
    `*👥 Wateja:*`,
    `  👤 Wote: ${userStats.total}`,
    `  🆕 Wiki hii: ${userStats.thisWeek}`,
    `  🚫 Waliozuiwa: ${userStats.blocked}`,
  ].join('\n')

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('📈 Kila Siku', 'admin:analytics:daily'),
        Markup.button.callback('📊 Wiki', 'admin:analytics:weekly'),
      ],
      [
        Markup.button.callback('📅 Mwezi', 'admin:analytics:monthly'),
        Markup.button.callback('⭐ Bidhaa Bora', 'admin:analytics:top_products'),
      ],
      [
        Markup.button.callback('💰 Mapato', 'admin:analytics:revenue'),
      ],
      [Markup.button.callback('◀️ Rudi', 'admin:menu')],
    ]),
  })
}

async function showPeriodReport(ctx, period) {
  const days = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Pata orders zilizopita
  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['paid', 'delivered'] },
      paidAt: { gte: since },
    },
    orderBy: { paidAt: 'asc' },
    select: { paidAt: true, totalTzs: true },
  })

  // Group kwa siku
  const byDay = {}
  for (const order of orders) {
    const day = new Date(order.paidAt).toLocaleDateString('sw-TZ')
    if (!byDay[day]) byDay[day] = { count: 0, tzs: 0 }
    byDay[day].count++
    byDay[day].tzs += order.totalTzs
  }

  const periodName = period === 'daily' ? 'Leo' : period === 'weekly' ? 'Wiki Hii' : 'Mwezi Huu'

  let text = `📊 *Ripoti — ${periodName}*\n\n`

  if (Object.keys(byDay).length === 0) {
    text += '_Hakuna mauzo kwenye kipindi hiki_'
  } else {
    for (const [day, data] of Object.entries(byDay)) {
      text += `📅 ${escapeMarkdown(day)}: ${data.count} maagizo — TZS ${data.tzs.toLocaleString('en-US')}\n`
    }
    const totalRevenue = Object.values(byDay).reduce((s, d) => s + d.tzs, 0)
    const totalOrders = Object.values(byDay).reduce((s, d) => s + d.count, 0)
    text += `\n*Jumla: ${totalOrders} maagizo — TZS ${totalRevenue.toLocaleString('en-US')}*`
  }

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Analytics', 'admin:analytics')]]),
  })
}

async function showTopProducts(ctx) {
  const products = await prisma.product.findMany({
    where: { salesCount: { gt: 0 } },
    orderBy: { salesCount: 'desc' },
    take: 10,
    select: { name: true, salesCount: true, priceStars: true, productType: true },
  })

  if (products.length === 0) {
    await ctx.editMessageText(
      '📊 Hakuna bidhaa zilizouzwa bado.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️ Rudi', 'admin:analytics')]])
    )
    return
  }

  let text = '⭐ *Bidhaa Zinazouzwa Zaidi:*\n\n'
  for (let i = 0; i < products.length; i++) {
    const p = products[i]
    const icon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
    const revenue = p.salesCount * p.priceStars
    text += `${icon} ${escapeMarkdown(p.name)}\n`
    text += `   ${p.salesCount} mauzo — ⭐ ${revenue} jumla\n\n`
  }

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Analytics', 'admin:analytics')]]),
  })
}

async function showRevenueReport(ctx) {
  const [paid, delivered, pending, failed] = await Promise.all([
    prisma.order.aggregate({
      where: { status: 'paid' },
      _sum: { totalTzs: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: { status: 'delivered' },
      _sum: { totalTzs: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: { status: 'pending' },
      _sum: { totalTzs: true },
      _count: true,
    }),
    prisma.order.aggregate({
      where: { status: { in: ['failed', 'cancelled'] } },
      _count: true,
    }),
  ])

  const totalRevenue = (paid._sum.totalTzs || 0) + (delivered._sum.totalTzs || 0)

  let text = [
    `💰 *Ripoti ya Mapato*`,
    ``,
    `✅ Imelipwa: TZS ${(paid._sum.totalTzs || 0).toLocaleString('en-US')} \\(${paid._count} maagizo\\)`,
    `📬 Imetumwa: TZS ${(delivered._sum.totalTzs || 0).toLocaleString('en-US')} \\(${delivered._count} maagizo\\)`,
    `⏳ Inasubiri: ${pending._count} maagizo`,
    `❌ Zilizoshindwa: ${failed._count} maagizo`,
    ``,
    `💫 *Jumla: TZS ${totalRevenue.toLocaleString('en-US')}*`,
  ].join('\n')

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Analytics', 'admin:analytics')]]),
  })
}

// ─── Helpers ─────────────────────────────────────────────────

async function getOrderStats(dateFilter) {
  const where = {
    status: { in: ['paid', 'delivered'] },
    ...(Object.keys(dateFilter).length ? { paidAt: dateFilter } : {}),
  }

  const [agg, failedCount] = await Promise.all([
    prisma.order.aggregate({
      where,
      _sum: { totalTzs: true },
      _count: true,
    }),
    prisma.order.count({ where: { status: { in: ['failed', 'cancelled'] } } }),
  ])

  return {
    count: agg._count || 0,
    revenue: agg._sum.totalTzs || 0,
    failed: failedCount,
  }
}

async function getUserStats() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const [total, thisWeek, blocked] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { isBlocked: true } }),
  ])
  return { total, thisWeek, blocked }
}

module.exports = { registerAdminAnalyticsHandlers }
