'use strict'

const { Markup } = require('telegraf')
const { isAdmin, auditLog } = require('../middlewares/auth')
const { escapeMarkdown, formatOrderStatus, formatDate } = require('../utils/formatting')
const { adminGetOrders, getOrderById, adminManualConfirm, cancelOrder } = require('../services/orderService')
const { deliverOrder } = require('../services/deliveryService')
const { prisma } = require('../database')
const logger = require('../utils/logger')

function registerAdminOrderHandlers(bot) {
  // ─── Orders List ────────────────────────────────────────────
  bot.action(/^admin:orders(:page:(\d+))?(:filter:(\w+))?$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const page = parseInt(ctx.match[2] || '1')
    const filter = ctx.match[4] || ''
    await showOrdersList(ctx, page, filter)
  })

  // Quick filter buttons
  for (const status of ['pending', 'paid', 'delivered', 'failed', 'refunded']) {
    bot.action(`admin:orders:filter:${status}`, isAdmin, async (ctx) => {
      await ctx.answerCbQuery()
      await showOrdersList(ctx, 1, status)
    })
  }

  // ─── View Single Order ──────────────────────────────────────
  bot.action(/^admin:order:view:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const orderId = parseInt(ctx.match[1])
    await showOrderDetail(ctx, orderId)
  })

  // ─── Manual Confirm Payment ─────────────────────────────────
  bot.action(/^admin:order:confirm:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const orderId = parseInt(ctx.match[1])

    await ctx.editMessageText(
      `⚠️ *Thibitisha Malipo ya Order \\#${orderId}?*\n\n` +
      `Unafanya thibitisho la mkono\\. Bidhaa itatumwa mara moja\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Ndiyo, Thibitisha', `admin:order:confirm_yes:${orderId}`),
            Markup.button.callback('❌ Hapana', `admin:order:view:${orderId}`),
          ],
        ]),
      }
    )
  })

  bot.action(/^admin:order:confirm_yes:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery('Inashughulikia...')
    const orderId = parseInt(ctx.match[1])

    try {
      const order = await adminManualConfirm(orderId, `Manual confirm na admin ${ctx.from.id}`)
      await auditLog(ctx.from.id, 'order.manual_confirm', { orderId })

      // Tuma bidhaa
      await deliverOrder(bot.telegram, Number(order.user.telegramId), order)

      await ctx.editMessageText(
        `✅ *Order \\#${orderId} imethibitishwa na bidhaa imetumwa\\!*`,
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Maagizo', 'admin:orders')]]),
        }
      )
    } catch (err) {
      logger.error('Manual confirm failed', { error: err.message, orderId })
      await ctx.reply(`❌ Hitilafu: ${err.message}`)
    }
  })

  // ─── Cancel Order ────────────────────────────────────────────
  bot.action(/^admin:order:cancel:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const orderId = parseInt(ctx.match[1])
    await cancelOrder(orderId, `Imefutwa na admin ${ctx.from.id}`)
    await auditLog(ctx.from.id, 'order.cancelled', { orderId })
    await ctx.answerCbQuery('✅ Order imefutwa', { show_alert: true })
    await showOrdersList(ctx, 1, '')
  })

  // ─── Resend Delivery ─────────────────────────────────────────
  bot.action(/^admin:order:resend:(\d+)$/, isAdmin, async (ctx) => {
    await ctx.answerCbQuery('Inatuma tena...')
    const orderId = parseInt(ctx.match[1])

    try {
      const order = await getOrderById(orderId)
      if (!order) throw new Error('Order haipatikani')

      await deliverOrder(bot.telegram, Number(order.user.telegramId), order)
      await auditLog(ctx.from.id, 'order.resent', { orderId })
      await ctx.answerCbQuery('✅ Bidhaa imetumwa tena!', { show_alert: true })
    } catch (err) {
      await ctx.answerCbQuery(`❌ Hitilafu: ${err.message}`, { show_alert: true })
    }
  })

  // ─── Flagged Orders ──────────────────────────────────────────
  bot.action('admin:orders:flagged', isAdmin, async (ctx) => {
    await ctx.answerCbQuery()
    const orders = await prisma.order.findMany({
      where: { isFlagged: true },
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { telegramId: true, username: true } } },
    })

    if (orders.length === 0) {
      await ctx.editMessageText(
        '✅ Hakuna maagizo yaliyobeba bendera ya ulaghai.',
        Markup.inlineKeyboard([[Markup.button.callback('◀️ Rudi', 'admin:orders')]])
      )
      return
    }

    let text = '⚠️ *Maagizo Yaliyoashiria Ulaghai:*\n\n'
    for (const o of orders) {
      const user = o.user.username ? `@${o.user.username}` : String(o.user.telegramId)
      text += `• Order \\#${o.id} — ${escapeMarkdown(user)}\n`
      text += `  💬 ${escapeMarkdown(o.flagReason || 'Sababu haijabainishwa')}\n\n`
    }

    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Rudi', 'admin:orders')]]),
    })
  })
}

// ─── Display Functions ────────────────────────────────────────

async function showOrdersList(ctx, page = 1, filterStatus = '') {
  const filters = filterStatus ? { status: filterStatus } : {}
  const result = await adminGetOrders(page, filters)

  if (result.orders.length === 0) {
    const msg = filterStatus
      ? `📋 Hakuna maagizo ya hali ya *${escapeMarkdown(filterStatus)}*\\.`
      : '📋 Hakuna maagizo bado\\.'

    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Yote', 'admin:orders')],
        [Markup.button.callback('◀️ Rudi', 'admin:menu')],
      ]),
    })
    return
  }

  let text = `📋 *Maagizo \\(${result.total}\\)${filterStatus ? ` — ${escapeMarkdown(filterStatus)}` : ''}:*\n\n`

  for (const o of result.orders) {
    const user = o.user.username ? `@${o.user.username}` : String(o.user.telegramId)
    const status = formatOrderStatus(o.status)
    const flag = o.isFlagged ? '⚠️' : ''
    text += `${flag}*\\#${o.id}* ${escapeMarkdown(user)} — ⭐${o.totalStars} — ${status}\n`
  }

  text += `\n📄 Ukurasa ${result.page}/${result.totalPages}`

  const orderButtons = result.orders.map(o => [
    Markup.button.callback(`#${o.id} ${formatOrderStatus(o.status, 'en').substring(0, 15)}`, `admin:order:view:${o.id}`)
  ])

  const navButtons = []
  if (result.hasPrev) navButtons.push(Markup.button.callback('◀️', `admin:orders:page:${page - 1}`))
  if (result.hasNext) navButtons.push(Markup.button.callback('▶️', `admin:orders:page:${page + 1}`))
  if (navButtons.length) orderButtons.push(navButtons)

  orderButtons.push([
    Markup.button.callback('⏳ Pending', 'admin:orders:filter:pending'),
    Markup.button.callback('✅ Paid', 'admin:orders:filter:paid'),
    Markup.button.callback('⚠️ Flagged', 'admin:orders:flagged'),
  ])
  orderButtons.push([Markup.button.callback('◀️ Rudi', 'admin:menu')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(orderButtons) })
}

async function showOrderDetail(ctx, orderId) {
  const order = await getOrderById(orderId)
  if (!order) {
    await ctx.editMessageText('❌ Order haipatikani.')
    return
  }

  const user = order.user.username ? `@${order.user.username}` : String(order.user.telegramId)
  const status = formatOrderStatus(order.status)
  const paidAt = order.paidAt ? formatDate(order.paidAt) : 'Bado haijalipiwa'

  let text = [
    `📋 *Order \\#${order.id}*`,
    ``,
    `👤 Mteja: ${escapeMarkdown(user)}`,
    `💫 Stars: ⭐ ${order.totalStars}`,
    `📊 Hali: ${status}`,
    `💳 Malipo: ${escapeMarkdown(order.paymentMethod)}`,
    order.paymentReference ? `🆔 Charge ID: \`${escapeMarkdown(order.paymentReference)}\`` : '',
    `📅 Tarehe: ${escapeMarkdown(formatDate(order.createdAt))}`,
    order.paidAt ? `✅ Imelipwa: ${escapeMarkdown(paidAt)}` : '',
    order.coupon ? `🎟️ Coupon: ${escapeMarkdown(order.coupon.code)} \\(\\-⭐${order.couponDiscount}\\)` : '',
    order.isFlagged ? `\n⚠️ *BENDERA: ${escapeMarkdown(order.flagReason || '')}*` : '',
    ``,
    `📦 *Bidhaa:*`,
  ].filter(Boolean).join('\n')

  for (const item of order.items) {
    text += `\n• ${escapeMarkdown(item.product.name)} × ${item.quantity} — ⭐${item.starsAtPurchase}`
  }

  const buttons = []

  if (order.status === 'pending') {
    buttons.push([
      Markup.button.callback('✅ Thibitisha Malipo', `admin:order:confirm:${orderId}`),
      Markup.button.callback('🚫 Futa', `admin:order:cancel:${orderId}`),
    ])
  }

  if (['paid', 'delivered'].includes(order.status)) {
    buttons.push([
      Markup.button.callback('🔄 Tuma Tena', `admin:order:resend:${orderId}`),
    ])
  }

  buttons.push([Markup.button.callback('◀️ Maagizo', 'admin:orders')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) })
}

module.exports = { registerAdminOrderHandlers }
