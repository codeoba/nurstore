'use strict'

const { prisma } = require('../database')
const { markOrderPaid, checkFraud } = require('../services/orderService')
const { deliverOrder } = require('../services/deliveryService')
const { awardReferralCommission } = require('../services/referralService')
const { notifyAdminPaymentReceived } = require('../services/notificationService')
const logger = require('../utils/logger')

/**
 * Handler ya Telegram pre_checkout_query
 *
 * Telegram inaita hii ndani ya sekunde 10 baada ya mtumiaji kuthibitisha invoice.
 * Lazima tujibu kwa answerPreCheckoutQuery() ndani ya sekunde 10!
 *
 * @param {import('telegraf').Context} ctx
 */
async function handlePreCheckout(ctx) {
  const query = ctx.preCheckoutQuery

  logger.payment({
    event: 'PRE_CHECKOUT',
    queryId: query.id,
    userId: query.from.id,
    amount: query.total_amount,
    currency: query.currency,
    payload: query.invoice_payload,
  })

  try {
    // Parse payload
    let payload
    try {
      payload = JSON.parse(query.invoice_payload)
    } catch {
      await ctx.answerPreCheckoutQuery(false, 'Ombi si sahihi. Jaribu tena.')
      return
    }

    // Thibitisha order bado ipo na ni pending
    const order = await prisma.order.findUnique({
      where: { id: payload.orderId },
      select: { id: true, status: true, totalStars: true, userId: true },
    })

    if (!order) {
      await ctx.answerPreCheckoutQuery(false, 'Order haipatikani. Jaribu tena.')
      return
    }

    if (order.status !== 'pending') {
      await ctx.answerPreCheckoutQuery(false, 'Order hii tayari imeshughulikiwa.')
      return
    }

    // Thibitisha mtumiaji ni sahihi
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(query.from.id) },
      select: { id: true },
    })

    if (!user || user.id !== order.userId) {
      await ctx.answerPreCheckoutQuery(false, 'Ombi halijakuwa na ruhusa.')
      return
    }

    // Thibitisha amount (fraud check)
    if (query.total_amount !== order.totalStars) {
      logger.security('PRE_CHECKOUT_AMOUNT_MISMATCH', {
        orderId: order.id,
        expected: order.totalStars,
        received: query.total_amount,
        userId: query.from.id,
      })
      await ctx.answerPreCheckoutQuery(false, 'Hitilafu ya bei. Jaribu tena.')
      return
    }

    // Kila kitu sawa — ruhusu malipo
    await ctx.answerPreCheckoutQuery(true)

    logger.payment({
      event: 'PRE_CHECKOUT_APPROVED',
      orderId: order.id,
      userId: query.from.id,
    })
  } catch (err) {
    logger.error('Pre-checkout handler error', { error: err.message })
    try {
      await ctx.answerPreCheckoutQuery(false, 'Hitilafu ya ndani. Jaribu tena baadaye.')
    } catch {}
  }
}

/**
 * Handler ya successful_payment
 *
 * Telegram inaita hii baada ya mtumiaji kulipa kwa mafanikio.
 * Hapa ndipo tunatekeleza delivery ya bidhaa.
 *
 * @param {import('telegraf').Context} ctx
 */
async function handleSuccessfulPayment(ctx) {
  const payment = ctx.message.successful_payment
  const telegramUserId = ctx.from.id

  logger.payment({
    event: 'SUCCESSFUL_PAYMENT',
    telegramChargeId: payment.telegram_payment_charge_id,
    providerChargeId: payment.provider_payment_charge_id,
    currency: payment.currency,
    amount: payment.total_amount,
    userId: telegramUserId,
    payload: payment.invoice_payload,
  })

  try {
    // Parse payload
    let payload
    try {
      payload = JSON.parse(payment.invoice_payload)
    } catch {
      logger.error('Failed to parse payment payload', { payload: payment.invoice_payload })
      await ctx.reply('✅ Malipo yamepokelewa! Tafadhali wasiliana na /support kama hupokei bidhaa.')
      return
    }

    const orderId = payload.orderId

    // Fraud check
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, totalStars: true, userId: true },
    })

    if (!order) {
      logger.error('Order not found after successful payment', { orderId, telegramChargeId: payment.telegram_payment_charge_id })
      await ctx.reply('✅ Malipo yamepokelewa! Tunaproces bidhaa yako...')
      return
    }

    const fraudCheck = await checkFraud(order, payment.total_amount)
    if (fraudCheck.isFraud) {
      logger.security('FRAUD_AFTER_PAYMENT', {
        orderId,
        reasons: fraudCheck.reasons,
        telegramChargeId: payment.telegram_payment_charge_id,
      })
      // Endelea kutuma bidhaa hata kama kuna fraud flag (Telegram tayari imechukua malipo)
      // Admin ataona flag na ataangalia baadaye
    }

    // Mark order kama paid na pata order kamili
    const paidOrder = await markOrderPaid(
      orderId,
      payment.telegram_payment_charge_id,
      {
        telegram_payment_charge_id: payment.telegram_payment_charge_id,
        provider_payment_charge_id: payment.provider_payment_charge_id,
        total_amount: payment.total_amount,
        currency: payment.currency,
      }
    )

    if (!paidOrder) {
      // Tayari imeshughulikiwa (duplicate)
      logger.warn('Duplicate payment event ignored', { orderId })
      return
    }

    // Tuma bidhaa mara moja
    await deliverOrder(ctx.telegram, telegramUserId, paidOrder)

    // Toa commission kwa referral (kama ipo)
    await awardReferralCommission(paidOrder.userId, paidOrder.totalStars)
      .then(commission => {
        if (commission > 0) {
          // Tuma notification kwa mwasilishaji (background)
          notifyReferralCommissionIfNeeded(ctx, paidOrder.userId, commission)
        }
      })
      .catch(() => {})

    // Notify admin
    await notifyAdminPaymentReceived(ctx.telegram, paidOrder)
      .catch(() => {})

    // Futa cart ya mtumiaji baada ya ununuzi
    const dbUser = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUserId) },
      select: { id: true },
    })
    if (dbUser) {
      await prisma.cartItem.deleteMany({ where: { userId: dbUser.id } }).catch(() => {})
    }
  } catch (err) {
    logger.error('Successful payment handler error', {
      error: err.message,
      telegramUserId,
      chargeId: payment.telegram_payment_charge_id,
    })

    await ctx.reply(
      '✅ Malipo yamefanikiwa! Tunashughulikia bidhaa yako.\n' +
      'Kama hupokei bidhaa ndani ya dakika 5, tafadhali wasiliana nasi: /support'
    ).catch(() => {})
  }
}

/**
 * Unda Telegram invoice payload kwa order
 * @param {number} orderId
 * @param {number} userId - Telegram user ID
 * @returns {string} JSON payload
 */
function createInvoicePayload(orderId, userId) {
  return JSON.stringify({
    orderId,
    userId,
    timestamp: Date.now(),
  })
}

/**
 * Unda invoice parameters kwa bidhaa moja (Buy Now)
 */
function buildInvoice(order, product, payload) {
  const { isDiscountActive } = require('../utils/formatting')
  const stars = isDiscountActive(product) ? product.discountStars : product.priceStars

  return {
    title: product.name.substring(0, 32), // Telegram limit: 32 chars
    description: (product.description || '').substring(0, 255), // Limit: 255 chars
    payload,
    currency: 'XTR',
    prices: [{ label: product.name.substring(0, 32), amount: stars }],
    // Picha ya bidhaa (kama ipo)
    ...(product.thumbnailFileId && { photo_url: null }), // Telegram Stars haichukui photo_url
  }
}

/**
 * Unda invoice parameters kwa cart (bidhaa nyingi)
 */
function buildCartInvoice(order, cartItems, payload) {
  const { isDiscountActive } = require('../utils/formatting')

  const prices = cartItems.map(item => {
    const product = item.product
    const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
    return {
      label: product.name.substring(0, 32),
      amount: stars * item.quantity,
    }
  })

  // Ongeza discount kama ipo
  if (order.couponDiscount && order.couponDiscount > 0) {
    prices.push({
      label: `🎟️ Coupon Discount`,
      amount: -order.couponDiscount,
    })
  }

  const storeName = require('../config').bot.storeName

  return {
    title: `${storeName} — Ununuzi`.substring(0, 32),
    description: `Bidhaa ${cartItems.length}: ${cartItems.map(i => i.product.name).join(', ')}`.substring(0, 255),
    payload,
    currency: 'XTR',
    prices,
  }
}

// ─── Background Helpers ───────────────────────────────────────

async function notifyReferralCommissionIfNeeded(ctx, buyerUserId, commission) {
  try {
    const { notifyReferralCommission } = require('../services/notificationService')
    const buyer = await prisma.user.findUnique({
      where: { id: buyerUserId },
      select: { referredBy: true, fullName: true },
    })

    if (!buyer?.referredBy) return

    const referrer = await prisma.user.findUnique({
      where: { id: buyer.referredBy },
      select: { telegramId: true },
    })

    if (!referrer) return

    await notifyReferralCommission(
      ctx.telegram,
      Number(referrer.telegramId),
      commission,
      buyer.fullName
    )
  } catch (err) {
    logger.error('Referral notification error', { error: err.message })
  }
}

module.exports = {
  handlePreCheckout,
  handleSuccessfulPayment,
  createInvoicePayload,
  buildInvoice,
  buildCartInvoice,
}
