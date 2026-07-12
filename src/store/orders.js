'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { escapeMarkdown, formatOrderStatus, formatOrderSummary, formatDate } = require('../utils/formatting')
const { getUserOrders, getOrderById } = require('../services/orderService')
const { redeliverProduct } = require('../services/deliveryService')
const { contentRateLimit } = require('../middlewares/rateLimit')
const logger = require('../utils/logger')

function registerOrdersHandlers(bot) {
  // ─── My Orders ────────────────────────────────────────────────
  bot.command('myorders', async (ctx) => {
    await showMyOrders(ctx, 1)
  })

  bot.action(/^store:orders(:page:(\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery()
    const page = parseInt(ctx.match[2] || '1')
    await showMyOrders(ctx, page)
  })

  // ─── View Single Order ────────────────────────────────────────
  bot.action(/^store:order:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const orderId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    await showOrderDetail(ctx, orderId, lang)
  })

  // ─── Re-download / Re-view Content ────────────────────────────
  bot.action(/^store:order:download:(\d+):(\d+)$/, contentRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const orderId = parseInt(ctx.match[1])
    const productId = parseInt(ctx.match[2])
    const lang = ctx.session?.language || 'sw'

    try {
      await redeliverProduct(ctx.telegram, ctx.from.id, orderId, productId)
    } catch (err) {
      logger.error('Re-delivery error', { error: err.message })
      await ctx.reply(
        lang === 'sw'
          ? `❌ Hitilafu: ${err.message}`
          : `❌ Error: ${err.message}`
      )
    }
  })

  // ─── Refund Request Wizard Init ───────────────────────────────
  bot.action(/^store:refund:start:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const orderId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    ctx.session.userWizard = { scene: 'refund', step: 'reason', data: { orderId } }

    await ctx.editMessageText(
      lang === 'sw'
        ? '🔄 *Omba Refund*\n\nTafadhali andika sababu ya kuomba refund ya malipo ya order hii:'
        : '🔄 *Request Refund*\n\nPlease write the reason for requesting a refund for this order:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', `store:order:${orderId}`)]]),
      }
    )
  })

  // ─── Leave Review ─────────────────────────────────────────────
  bot.action(/^store:review:start:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    // Angalia kama tayari ameacha review
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const existing = await prisma.review.findUnique({
      where: { productId_userId: { productId, userId: user.id } },
    })

    if (existing) {
      await ctx.answerCbQuery(
        lang === 'sw' ? '⭐ Tayari umeacha review kwa bidhaa hii.' : '⭐ You already reviewed this product.',
        { show_alert: true }
      )
      return
    }

    ctx.session.userWizard = { scene: 'review', step: 'rating', data: { productId, userId: user.id } }

    await ctx.editMessageText(
      lang === 'sw'
        ? '⭐ *Acha Review*\n\nChagua rating yako:'
        : '⭐ *Leave a Review*\n\nChoose your rating:',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⭐', 'store:review:rate:1'),
            Markup.button.callback('⭐⭐', 'store:review:rate:2'),
            Markup.button.callback('⭐⭐⭐', 'store:review:rate:3'),
          ],
          [
            Markup.button.callback('⭐⭐⭐⭐', 'store:review:rate:4'),
            Markup.button.callback('⭐⭐⭐⭐⭐', 'store:review:rate:5'),
          ],
          [Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', 'store:orders')],
        ]),
      }
    )
  })

  bot.action(/^store:review:rate:(\d)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const rating = parseInt(ctx.match[1])
    const wizard = ctx.session?.userWizard
    if (!wizard || wizard.scene !== 'review') return

    wizard.data.rating = rating
    wizard.step = 'comment'
    const lang = ctx.session?.language || 'sw'

    await ctx.editMessageText(
      lang === 'sw'
        ? `✅ Rating: ${'⭐'.repeat(rating)}\n\nAndika maoni yako \\(au andika "skip"\\):`
        : `✅ Rating: ${'⭐'.repeat(rating)}\n\nWrite your comment \\(or type "skip"\\):`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', 'store:orders')]]),
      }
    )
  })
}

// ─── Review Wizard Handler ────────────────────────────────────

async function handleReviewWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard || wizard.scene !== 'review' || wizard.step !== 'comment') return false

  const lang = ctx.session?.language || 'sw'
  const text = ctx.message?.text?.trim()
  const comment = text?.toLowerCase() === 'skip' ? null : text?.substring(0, 500)

  ctx.session.userWizard = null

  try {
    await prisma.review.create({
      data: {
        productId: wizard.data.productId,
        userId: wizard.data.userId,
        rating: wizard.data.rating,
        comment: comment || null,
      },
    })

    await ctx.reply(
      lang === 'sw'
        ? `✅ *Asante kwa review yako\\!* ${'⭐'.repeat(wizard.data.rating)}`
        : `✅ *Thank you for your review\\!* ${'⭐'.repeat(wizard.data.rating)}`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📦 Maagizo Yangu' : '📦 My Orders', 'store:orders')]]),
      }
    )
  } catch (err) {
    await ctx.reply(lang === 'sw' ? '❌ Hitilafu kutuma review. Jaribu tena.' : '❌ Error submitting review.')
  }

  return true
}

// ─── Display Functions ────────────────────────────────────────

async function showMyOrders(ctx, page = 1) {
  const lang = ctx.session?.language || 'sw'
  const user = await getDbUser(ctx.from.id)
  if (!user) {
    const msg = lang === 'sw' ? 'Tafadhali anza kwa /start' : 'Please start with /start'
    ctx.callbackQuery ? await ctx.editMessageText(msg) : await ctx.reply(msg)
    return
  }

  const result = await getUserOrders(user.id, page)

  if (result.orders.length === 0) {
    const text = lang === 'sw'
      ? '📦 *Maagizo Yangu*\n\nHaujawahi kununua chochote bado\\.\n\nAngalia bidhaa zetu:'
      : '📦 *My Orders*\n\nYou haven\'t made any purchases yet\\.\n\nBrowse our products:'

    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Bidhaa' : '🛍️ Browse Products', 'store:browse')],
      [Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')],
    ])

    ctx.callbackQuery
      ? await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...buttons })
      : await ctx.reply(text, { parse_mode: 'MarkdownV2', ...buttons })
    return
  }

  const title = lang === 'sw'
    ? `📦 *Maagizo Yangu \\(${result.total}\\):*\n\n`
    : `📦 *My Orders \\(${result.total}\\):*\n\n`

  let text = title
  for (const order of result.orders) {
    text += formatOrderSummary(order, lang) + '\n'
  }

  const orderButtons = result.orders.map(o => [
    Markup.button.callback(
      `#${o.id} — ${formatOrderStatus(o.status, lang).substring(0, 20)}`,
      `store:order:${o.id}`
    )
  ])

  const navButtons = []
  if (result.hasPrev) navButtons.push(Markup.button.callback('◀️', `store:orders:page:${page - 1}`))
  if (result.hasNext) navButtons.push(Markup.button.callback('▶️', `store:orders:page:${page + 1}`))
  if (navButtons.length) orderButtons.push(navButtons)

  orderButtons.push([Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:menu')])

  const keyboard = Markup.inlineKeyboard(orderButtons)

  ctx.callbackQuery
    ? await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
    : await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
}

async function showOrderDetail(ctx, orderId, lang = 'sw') {
  const user = await getDbUser(ctx.from.id)
  if (!user) return

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId: user.id }, // Thibitisha ni ya mtumiaji huyu
    include: {
      items: {
        include: {
          product: {
            select: { id: true, name: true, productType: true, filePath: true },
          },
        },
      },
    },
  })

  if (!order) {
    await ctx.editMessageText(
      lang === 'sw' ? '❌ Order haipatikani.' : '❌ Order not found.',
      Markup.inlineKeyboard([[Markup.button.callback('◀️', 'store:orders')]])
    )
    return
  }

  // Kagua kama kuna refund request ya order hii
  const refundReq = await prisma.refundRequest.findUnique({
    where: { orderId: order.id }
  })

  const status = formatOrderStatus(order.status, lang)
  const date = formatDate(order.createdAt, lang)

  let refundStatusText = ''
  if (refundReq) {
    const refStatusesSw = { pending: 'Inasubiri Wasimamizi ⏳', approved: 'Imeidhinishwa ✅', rejected: 'Imekataliwa ❌' }
    const refStatusesEn = { pending: 'Pending Approval ⏳', approved: 'Approved ✅', rejected: 'Rejected ❌' }
    refundStatusText = lang === 'sw'
      ? `\n🔄 *Hali ya Refund:* ${refStatusesSw[refundReq.status]}`
      : `\n🔄 *Refund Status:* ${refStatusesEn[refundReq.status]}`
  }

  let text = lang === 'sw'
    ? [
        `📋 *Order \\#${order.id}*`,
        `📅 Tarehe: ${escapeMarkdown(date)}`,
        `💰 Kiasi: TZS ${order.totalTzs.toLocaleString('en-US')}`,
        `📊 Hali: ${status}${escapeMarkdown(refundStatusText)}`,
        ``,
        `📦 *Bidhaa Zako:*`,
      ].join('\n')
    : [
        `📋 *Order \\#${order.id}*`,
        `📅 Date: ${escapeMarkdown(date)}`,
        `💰 Amount: TZS ${order.totalTzs.toLocaleString('en-US')}`,
        `📊 Status: ${status}${escapeMarkdown(refundStatusText)}`,
        ``,
        `📦 *Your Products:*`,
      ].join('\n')

  for (const item of order.items) {
    text += `\n• ${escapeMarkdown(item.product.name)}`
  }

  // Buttons za kila bidhaa (download / view)
  const itemButtons = []

  if (['paid', 'delivered'].includes(order.status)) {
    for (const item of order.items) {
      const label = item.product.productType === 'text_content'
        ? (lang === 'sw' ? '📄 Soma Content' : '📄 View Content')
        : (lang === 'sw' ? '📥 Pakua' : '📥 Download')

      itemButtons.push([
        Markup.button.callback(
          `${label}: ${item.product.name.substring(0, 20)}`,
          `store:order:download:${order.id}:${item.product.id}`
        ),
      ])
    }

    // Review button kwa bidhaa iliyonunuliwa
    if (order.items.length > 0) {
      itemButtons.push([
        Markup.button.callback(
          lang === 'sw' ? '⭐ Acha Review' : '⭐ Leave Review',
          `store:review:start:${order.items[0].product.id}`
        ),
      ])
    }

    // Kama hajawahi kuomba refund ya bidhaa hii bado, mruhusu kuomba
    if (!refundReq) {
      itemButtons.push([
        Markup.button.callback(
          lang === 'sw' ? '🔄 Omba Refund' : '🔄 Request Refund',
          `store:refund:start:${order.id}`
        )
      ])
    }
  }

  itemButtons.push([Markup.button.callback(lang === 'sw' ? '◀️ Maagizo' : '◀️ Orders', 'store:orders')])

  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(itemButtons) })
}

// ─── Helpers ─────────────────────────────────────────────────

async function getDbUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  })
}

module.exports = {
  registerOrdersHandlers,
  handleReviewWizard,
  handleRefundWizard,
}

async function handleRefundWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard || wizard.scene !== 'refund' || wizard.step !== 'reason') return false

  const lang = ctx.session?.language || 'sw'
  const text = ctx.message?.text?.trim()

  if (!text || text.length < 10) {
    await ctx.reply(
      lang === 'sw'
        ? '⚠️ Sababu lazima iwe na maneno angalau herufi 10. Tafadhali andika sababu kamili:'
        : '⚠️ Reason must be at least 10 characters long. Please write a full reason:'
    )
    return true
  }

  ctx.session.userWizard = null

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true }
    })

    const { createRefundRequest } = require('../services/refundService')
    const request = await createRefundRequest(user.id, wizard.data.orderId, text)

    await ctx.reply(
      lang === 'sw'
        ? `✅ *Ombi la Refund Limetumwa\\!*\n\nOmbi lako limepokelewa na linakaguliwa na Wasimamizi\\. Utajulishwa hapa pindi litakapothibitishwa\\.`
        : `✅ *Refund Request Sent\\!*\n\nYour request has been received and is being reviewed by the Admins\\. You will be notified here once it is resolved\\.`,
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(lang === 'sw' ? '📦 Maagizo Yangu' : '📦 My Orders', 'store:orders')]]),
      }
    )

    // Notify admins with inline approval options
    const { notifyAdmins } = require('../services/notificationService')
    const usernameStr = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(ctx.from.id)
    await notifyAdmins(
      ctx.telegram,
      `🔄 *Ombi Jipya la Refund (Order #${request.orderId})*\n\n` +
      `👤 Mteja: ${usernameStr}\n` +
      `💰 Kiasi: TZS ${request.order.totalTzs.toLocaleString('en-US')}\n` +
      `📝 Sababu: ${request.reason}\n`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Kubali (Approve)', `admin:refund:approve:${request.id}`),
          Markup.button.callback('❌ Kataa (Reject)', `admin:refund:reject:${request.id}`),
        ]
      ])
    ).catch(() => {})

  } catch (err) {
    await ctx.reply(
      lang === 'sw'
        ? `❌ Hitilafu ya kutuma ombi: ${err.message}`
        : `❌ Error sending request: ${err.message}`
    )
  }

  return true
}
