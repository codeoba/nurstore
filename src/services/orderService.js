'use strict'

const { prisma } = require('../database')
const logger = require('../utils/logger')

// ─── Cart Management ─────────────────────────────────────────

/**
 * Pata cart ya mtumiaji (na product info)
 */
async function getUserCart(userId) {
  return prisma.cartItem.findMany({
    where: { userId },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          priceStars: true,
          discountStars: true,
          discountStartsAt: true,
          discountEndsAt: true,
          stock: true,
          isActive: true,
          productType: true,
        },
      },
    },
    orderBy: { addedAt: 'asc' },
  })
}

/**
 * Hesabu jumla ya Stars kwa cart
 */
function calculateCartTotal(cartItems) {
  const { isDiscountActive } = require('../utils/formatting')
  return cartItems.reduce((total, item) => {
    const product = item.product
    const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
    return total + (stars * item.quantity)
  }, 0)
}

// ─── Order Creation ───────────────────────────────────────────

/**
 * Tengeneza order mpya kutoka kwa cart
 * @param {number} userId - DB user ID
 * @param {Array} cartItems - Cart items na product info
 * @param {number|null} couponId - Optional coupon
 * @param {number} couponDiscount - Stars zilizopunguzwa
 * @returns {object} Order iliyoundwa
 */
async function createOrderFromCart(userId, cartItems, couponId = null, couponDiscount = 0) {
  const { isDiscountActive } = require('../utils/formatting')

  if (cartItems.length === 0) {
    throw new Error('Cart iko tupu')
  }

  // Angalia stock na bei kwa kila bidhaa kabla ya kuunda order
  for (const item of cartItems) {
    const product = item.product
    if (!product.isActive) {
      throw new Error(`Bidhaa "${product.name}" haipo tena`)
    }
    if (product.stock !== null && product.stock < item.quantity) {
      throw new Error(`Bidhaa "${product.name}" imekwisha (iliyobaki: ${product.stock})`)
    }
  }

  const totalStars = calculateCartTotal(cartItems) - couponDiscount
  if (totalStars < 1) throw new Error('Jumla ya bei lazima iwe Stars 1+')

  // Tengeneza order na items zote kwenye transaction moja
  const order = await prisma.$transaction(async (tx) => {
    const newOrder = await tx.order.create({
      data: {
        userId,
        totalStars: Math.max(totalStars, 1),
        status: 'pending',
        paymentMethod: 'telegram_stars',
        couponId,
        couponDiscount: couponDiscount || null,
        items: {
          create: cartItems.map(item => {
            const product = item.product
            const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
            return {
              productId: product.id,
              starsAtPurchase: stars,
              priceAtPurchase: stars * 32,
              quantity: item.quantity,
            }
          }),
        },
      },
      include: {
        items: { include: { product: { select: { id: true, name: true, productType: true } } } },
      },
    })

    return newOrder
  })

  logger.info('Order created', {
    orderId: order.id,
    userId,
    totalStars: order.totalStars,
    itemsCount: cartItems.length,
  })

  return order
}

/**
 * Tengeneza order ya bidhaa moja bila cart (Buy Now)
 */
async function createDirectOrder(userId, productId, couponId = null, couponDiscount = 0) {
  const { isDiscountActive } = require('../utils/formatting')

  const product = await prisma.product.findUnique({
    where: { id: productId, isActive: true },
    select: {
      id: true,
      name: true,
      priceStars: true,
      discountStars: true,
      discountStartsAt: true,
      discountEndsAt: true,
      stock: true,
      productType: true,
    },
  })

  if (!product) throw new Error('Bidhaa haipatikani')
  if (product.stock !== null && product.stock < 1) throw new Error('Bidhaa imekwisha')

  const stars = isDiscountActive(product) ? product.discountStars : product.priceStars
  const totalStars = Math.max(stars - couponDiscount, 1)

  const order = await prisma.order.create({
    data: {
      userId,
      totalStars,
      status: 'pending',
      paymentMethod: 'telegram_stars',
      couponId,
      couponDiscount: couponDiscount || null,
      items: {
        create: [{
          productId: product.id,
          starsAtPurchase: stars,
          priceAtPurchase: stars * 32,
          quantity: 1,
        }],
      },
    },
    include: {
      items: { include: { product: true } },
    },
  })

  logger.info('Direct order created', { orderId: order.id, userId, productId, totalStars })
  return order
}

// ─── Order Status Management ──────────────────────────────────

/**
 * Weka order kama imelipwa
 * @param {number} orderId
 * @param {string} telegramChargeId - Telegram payment charge ID
 * @param {object} rawPayment - Full payment object kutoka Telegram
 */
async function markOrderPaid(orderId, telegramChargeId, rawPayment = {}) {
  const order = await prisma.$transaction(async (tx) => {
    // Angalia kama order tayari imelipwa (kuzuia duplicate processing)
    const existing = await tx.payment.findUnique({
      where: { orderId },
    })

    if (existing?.status === 'completed') {
      logger.warn('Duplicate payment attempt', { orderId, telegramChargeId })
      return null
    }

    // Weka idempotency key kuzuia double-processing
    const idempotencyKey = `tg_${telegramChargeId}`

    // Check kama charge ID tayari imeshatumika
    const existingByCharge = await tx.payment.findUnique({
      where: { idempotencyKey }
    }).catch(() => null)

    if (existingByCharge) {
      logger.warn('Duplicate charge ID', { telegramChargeId, orderId })
      return null
    }

    // Unda payment record
    await tx.payment.upsert({
      where: { orderId },
      update: {
        telegramChargeId,
        status: 'completed',
        rawResponse: rawPayment,
        idempotencyKey,
      },
      create: {
        orderId,
        gateway: 'telegram_stars',
        telegramChargeId,
        amount: rawPayment.total_amount || 0,
        currency: rawPayment.currency || 'XTR',
        status: 'completed',
        rawResponse: rawPayment,
        idempotencyKey,
      },
    })

    // Update order status
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'paid',
        paymentReference: telegramChargeId,
        paidAt: new Date(),
      },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                productType: true,
                filePath: true,
                fileTelegramId: true,
                lockedContent: true,
                contentFormat: true,
              },
            },
          },
        },
        user: { select: { id: true, telegramId: true, fullName: true } },
      },
    })

    return updatedOrder
  })

  if (order) {
    logger.payment({
      event: 'ORDER_PAID',
      orderId,
      telegramChargeId,
      totalStars: order.totalStars,
      userId: order.userId,
    })

    // Punguza stock kwa kila bidhaa
    for (const item of order.items) {
      if (item.product && item.product.stock !== null) {
        await prisma.product.update({
          where: { id: item.product.id },
          data: {
            stock: { decrement: item.quantity },
            salesCount: { increment: item.quantity },
          },
        }).catch(err => logger.error('Stock update error', { error: err.message }))
      } else if (item.product) {
        await prisma.product.update({
          where: { id: item.product.id },
          data: { salesCount: { increment: item.quantity } },
        }).catch(() => {})
      }
    }

    // Tumia coupon (increment used_count)
    if (order.couponId) {
      await prisma.coupon.update({
        where: { id: order.couponId },
        data: { usedCount: { increment: 1 } },
      }).catch(() => {})
    }
  }

  return order
}

/**
 * Weka order kama imetumwa (delivered)
 */
async function markOrderDelivered(orderId) {
  return prisma.$transaction(async (tx) => {
    await tx.orderItem.updateMany({
      where: { orderId },
      data: { isDelivered: true },
    })

    return tx.order.update({
      where: { id: orderId },
      data: { status: 'delivered', deliveredAt: new Date() },
    })
  })
}

/**
 * Thibitisha malipo kwa mkono (admin manual confirm)
 */
async function adminManualConfirm(orderId, adminNote = '') {
  const order = await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'paid',
      paidAt: new Date(),
      paymentMethod: 'manual',
      notes: adminNote,
    },
    include: {
      items: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              productType: true,
              filePath: true,
              fileTelegramId: true,
              lockedContent: true,
              contentFormat: true,
            },
          },
        },
      },
      user: { select: { id: true, telegramId: true, fullName: true } },
    },
  })

  logger.audit('admin', 'order.manual_confirm', { orderId, note: adminNote })
  return order
}

/**
 * Futa order (cancel)
 */
async function cancelOrder(orderId, reason = '') {
  return prisma.order.update({
    where: { id: orderId },
    data: { status: 'cancelled', notes: reason },
  })
}

// ─── Order Queries ────────────────────────────────────────────

/**
 * Pata orders za mtumiaji mmoja
 */
async function getUserOrders(userId, page = 1, limit = 5) {
  const skip = (page - 1) * limit

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, productType: true } },
          },
        },
      },
    }),
    prisma.order.count({ where: { userId } }),
  ])

  return {
    orders,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNext: skip + limit < total,
    hasPrev: page > 1,
  }
}

/**
 * Pata order moja kwa admin
 */
async function getOrderById(orderId) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { product: true } },
      user: { select: { telegramId: true, username: true, fullName: true } },
      payment: true,
      coupon: { select: { code: true } },
    },
  })
}

/**
 * Pata orders zote kwa admin (pagination + filters)
 */
async function adminGetOrders(page = 1, filters = {}) {
  const limit = 10
  const skip = (page - 1) * limit

  const where = {
    ...(filters.status && { status: filters.status }),
    ...(filters.userId && { userId: filters.userId }),
    ...(filters.isFlagged !== undefined && { isFlagged: filters.isFlagged }),
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { product: { select: { name: true } } } },
        user: { select: { telegramId: true, username: true } },
        payment: { select: { status: true, telegramChargeId: true } },
      },
    }),
    prisma.order.count({ where }),
  ])

  return {
    orders,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNext: skip + limit < total,
    hasPrev: page > 1,
  }
}

// ─── Fraud Detection ─────────────────────────────────────────

/**
 * Angalia order kwa alama za ulaghai
 */
async function checkFraud(order, paymentAmount) {
  const reasons = []

  // Angalia kama amount haiendani na bei ya bidhaa
  if (Math.abs(paymentAmount - order.totalStars) > 2) {
    reasons.push(`Amount mismatch: expected ${order.totalStars}, got ${paymentAmount}`)
  }

  if (reasons.length > 0) {
    await prisma.order.update({
      where: { id: order.id },
      data: { isFlagged: true, flagReason: reasons.join('; ') },
    })

    logger.security('FRAUD_FLAG', {
      orderId: order.id,
      reasons,
      paymentAmount,
      expectedAmount: order.totalStars,
    })

    return { isFraud: true, reasons }
  }

  return { isFraud: false, reasons: [] }
}

module.exports = {
  getUserCart,
  calculateCartTotal,
  createOrderFromCart,
  createDirectOrder,
  markOrderPaid,
  markOrderDelivered,
  adminManualConfirm,
  cancelOrder,
  getUserOrders,
  getOrderById,
  adminGetOrders,
  checkFraud,
}
