'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { escapeMarkdown, formatCartSummary, isDiscountActive, starsToTzs } = require('../utils/formatting')
const { getUserCart, calculateCartTotal, createOrderFromCart, createDirectOrder } = require('../services/orderService')
const { validateCoupon } = require('../services/referralService')
const { createInvoicePayload, buildInvoice, buildCartInvoice } = require('../payments/telegramPayments')
const { checkoutRateLimit } = require('../middlewares/rateLimit')
const logger = require('../utils/logger')

function registerCheckoutHandlers(bot) {
  // ─── Buy Now (Direct Purchase) ────────────────────────────────
  bot.action(/^store:buy:(\d+)$/, checkoutRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    await initDirectCheckout(ctx, user.id, productId, lang)
  })

  // ─── Coupon Input ─────────────────────────────────────────────
  bot.action('store:checkout:coupon', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'

    if (!ctx.session.userWizard) {
      ctx.session.userWizard = { scene: 'checkout', step: 'coupon_input', data: {} }
    } else {
      ctx.session.userWizard.step = 'coupon_input'
    }

    await ctx.editMessageText(
      lang === 'sw'
        ? '🎟️ *Ingiza Coupon Code:*\n\n_Mfano: SAVE20_'
        : '🎟️ *Enter Coupon Code:*\n\n_Example: SAVE20_',
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback(
          lang === 'sw' ? '❌ Ruka Coupon' : '❌ Skip Coupon',
          'store:checkout:pay'
        )]]),
      }
    )
  })

  // ─── Proceed to Pay (Cart) ────────────────────────────────────
  bot.action('store:checkout:pay', checkoutRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const wizard = ctx.session.userWizard
    const couponId = wizard?.data?.couponId || null
    const couponDiscount = wizard?.data?.couponDiscount || 0

    await sendCartInvoice(ctx, user.id, couponId, couponDiscount, lang)
    ctx.session.userWizard = null
  })

  // ─── Direct Buy Confirm (with/without coupon) ─────────────────
  bot.action(/^store:buy_confirm:(\d+)$/, checkoutRateLimit, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'
    const user = await getDbUser(ctx.from.id)
    if (!user) return

    const wizard = ctx.session.userWizard
    const couponId = wizard?.data?.couponId || null
    const couponDiscount = wizard?.data?.couponDiscount || 0

    await sendDirectInvoice(ctx, user.id, productId, couponId, couponDiscount, lang)
    ctx.session.userWizard = null
  })

  // ─── Coupon for Direct Buy ────────────────────────────────────
  bot.action(/^store:buy:coupon:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const productId = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    ctx.session.userWizard = {
      scene: 'directBuyCoupon',
      step: 'coupon_input',
      data: { productId },
    }

    await ctx.editMessageText(
      lang === 'sw' ? '🎟️ Ingiza coupon code:' : '🎟️ Enter coupon code:',
      Markup.inlineKeyboard([[Markup.button.callback(
        lang === 'sw' ? '❌ Ruka' : '❌ Skip',
        `store:buy_confirm:${productId}`
      )]])
    )
  })
}

// ─── Invoice Senders ──────────────────────────────────────────

/**
 * Tuma invoice ya bidhaa moja
 */
async function sendDirectInvoice(ctx, userId, productId, couponId, couponDiscount, lang) {
  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
    select: {
      id: true, name: true, description: true,
      priceStars: true, discountStars: true, discountStartsAt: true, discountEndsAt: true,
      thumbnailFileId: true, productType: true, stock: true,
    },
  })

  if (!product) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa haipatikani.' : '❌ Product not available.')
    return
  }

  // Angalia stock
  if (product.stock !== null && product.stock < 1) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa hii imekwisha stock.' : '❌ This product is out of stock.')
    return
  }

  try {
    // Unda order kwanza
    const order = await createDirectOrder(userId, productId, couponId, couponDiscount)

    const payload = createInvoicePayload(order.id, ctx.from.id)
    const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
    const finalStars = Math.max(stars - couponDiscount, 1)

    // Tuma invoice
    await ctx.replyWithInvoice({
      title: product.name.substring(0, 32),
      description: (product.description || '').substring(0, 255),
      payload,
      currency: 'XTR',
      prices: [{ label: product.name.substring(0, 32), amount: finalStars }],
      ...(couponDiscount > 0 && {
        // Telegram haioneshi discount lines kwa Stars, tumia description
      }),
    })

    logger.info('Direct invoice sent', { orderId: order.id, userId, productId, stars: finalStars })
  } catch (err) {
    logger.error('Failed to send direct invoice', { error: err.message })
    await ctx.reply(lang === 'sw' ? '❌ Hitilafu. Jaribu tena.' : '❌ Error. Please try again.')
  }
}

/**
 * Tuma invoice ya cart (bidhaa nyingi)
 */
async function sendCartInvoice(ctx, userId, couponId, couponDiscount, lang) {
  const cartItems = await getUserCart(userId)

  if (cartItems.length === 0) {
    await ctx.reply(lang === 'sw' ? '🛒 Kikapu chako ni tupu.' : '🛒 Your cart is empty.')
    return
  }

  try {
    // Unda order
    const order = await createOrderFromCart(userId, cartItems, couponId, couponDiscount)

    const payload = createInvoicePayload(order.id, ctx.from.id)

    // Unda prices array
    const prices = cartItems.map(item => {
      const product = item.product
      const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
      return {
        label: product.name.substring(0, 32),
        amount: stars * item.quantity,
      }
    })

    if (couponDiscount > 0) {
      prices.push({ label: 'Coupon Discount', amount: -couponDiscount })
    }

    const storeName = require('../config').bot.storeName

    await ctx.replyWithInvoice({
      title: `${storeName.substring(0, 25)} — Order`,
      description: `Bidhaa ${cartItems.length}: ${cartItems.map(i => i.product.name).join(', ')}`.substring(0, 255),
      payload,
      currency: 'XTR',
      prices,
    })

    logger.info('Cart invoice sent', {
      orderId: order.id,
      userId,
      items: cartItems.length,
      totalStars: order.totalStars,
    })
  } catch (err) {
    logger.error('Failed to send cart invoice', { error: err.message })
    await ctx.reply(
      lang === 'sw'
        ? `❌ Hitilafu: ${err.message}`
        : `❌ Error: ${err.message}`
    )
  }
}

// ─── Checkout Wizard Handler ──────────────────────────────────

/**
 * Shughulikia coupon input kutoka mtumiaji
 * Inaitwa kwenye message handler ya kuu
 */
async function handleCheckoutWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard) return false
  if (!['checkout', 'directBuyCoupon'].includes(wizard.scene)) return false
  if (wizard.step !== 'coupon_input') return false

  const code = ctx.message?.text?.trim().toUpperCase()
  const lang = ctx.session?.language || 'sw'

  if (!code) {
    await ctx.reply(lang === 'sw' ? '⚠️ Ingiza code ya coupon.' : '⚠️ Enter a coupon code.')
    return true
  }

  // Pata total ya cart au bidhaa
  let orderStars = 0
  const user = await getDbUser(ctx.from.id)
  if (!user) return true

  if (wizard.scene === 'checkout') {
    const cartItems = await getUserCart(user.id)
    orderStars = calculateCartTotal(cartItems)
  } else if (wizard.scene === 'directBuyCoupon') {
    const product = await prisma.product.findUnique({
      where: { id: wizard.data.productId },
      select: { priceStars: true, discountStars: true, discountStartsAt: true, discountEndsAt: true },
    })
    orderStars = isDiscountActive(product) ? product.discountStars : product.priceStars
  }

  const couponResult = await validateCoupon(code, orderStars)

  if (!couponResult.valid) {
    await ctx.reply(
      lang === 'sw'
        ? `❌ ${couponResult.error}`
        : `❌ ${couponResult.error}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(lang === 'sw' ? '🔄 Jaribu Tena' : '🔄 Try Again', 'store:checkout:coupon')],
        [Markup.button.callback(lang === 'sw' ? '❌ Ruka' : '❌ Skip', wizard.scene === 'checkout' ? 'store:checkout:pay' : `store:buy_confirm:${wizard.data.productId}`)],
      ])
    )
    return true
  }

  // Coupon ni sahihi!
  wizard.data.couponId = couponResult.couponId
  wizard.data.couponDiscount = couponResult.discount

  const successMsg = lang === 'sw'
    ? `✅ *Coupon \`${code}\` Imetumika\\!*\n\nPunguzo: ⭐ ${couponResult.discount}\nJumla mpya: ⭐ ${Math.max(orderStars - couponResult.discount, 1)}`
    : `✅ *Coupon \`${code}\` Applied\\!*\n\nDiscount: ⭐ ${couponResult.discount}\nNew Total: ⭐ ${Math.max(orderStars - couponResult.discount, 1)}`

  wizard.step = 'coupon_confirmed'

  await ctx.reply(successMsg, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([[
      Markup.button.callback(
        lang === 'sw' ? '⚡ Endelea Kulipa' : '⚡ Proceed to Pay',
        wizard.scene === 'checkout' ? 'store:checkout:pay' : `store:buy_confirm:${wizard.data.productId}`
      ),
    ]]),
  })

  return true
}

// ─── Init Direct Checkout ─────────────────────────────────────

async function initDirectCheckout(ctx, userId, productId, lang) {
  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
    select: {
      id: true, name: true, priceStars: true, discountStars: true,
      discountStartsAt: true, discountEndsAt: true, stock: true, productType: true,
    },
  })

  if (!product) {
    await ctx.reply(lang === 'sw' ? '❌ Bidhaa haipatikani.' : '❌ Product not available.')
    return
  }

  const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
  ctx.session.userWizard = { scene: 'directBuy', step: 'confirm', data: { productId } }

  const text = lang === 'sw'
    ? `⚡ *Nunua Sasa — ${escapeMarkdown(product.name)}*\n\n💫 Bei: ⭐ *${stars}* \\(${starsToTzs(stars)}\\)\n\nTaka kuendelea?`
    : `⚡ *Buy Now — ${escapeMarkdown(product.name)}*\n\n💫 Price: ⭐ *${stars}* \\(${starsToTzs(stars)}\\)\n\nProceed?`

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(lang === 'sw' ? '🎟️ Tumia Coupon' : '🎟️ Use Coupon', `store:buy:coupon:${productId}`),
        Markup.button.callback(lang === 'sw' ? '⚡ Lipia ⭐' + stars : '⚡ Pay ⭐' + stars, `store:buy_confirm:${productId}`),
      ],
      [Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', `store:product:${productId}`)],
    ]),
  })
}

// ─── Helpers ─────────────────────────────────────────────────

async function getDbUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  })
}

module.exports = {
  registerCheckoutHandlers,
  handleCheckoutWizard,
  sendDirectInvoice,
  sendCartInvoice,
}
