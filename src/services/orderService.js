'use strict'

const { prisma } = require('../database')
const { debitWallet } = require('./walletService')
const { awardReferralCommission } = require('./referralService')
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
          priceTzs: true,
          priceUsd: true,
          discountTzs: true,
          discountUsd: true,
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
 * Hesabu jumla ya bei kwa cart (TZS)
 */
function calculateCartTotal(cartItems) {
  const { isDiscountActive } = require('../utils/formatting')
  return cartItems.reduce((total, item) => {
    const product = item.product
    const price = isDiscountActive(product) ? product.discountTzs : product.priceTzs
    return total + (price * item.quantity)
  }, 0)
}

// ─── Order Creation ───────────────────────────────────────────

/**
 * Tengeneza order mpya kutoka kwa cart
 * @param {number} userId - DB user ID
 * @param {Array} cartItems - Cart items na product info
 * @param {number|null} couponId - Optional coupon
 * @param {number} couponDiscount - TZS zilizopunguzwa
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

  const totalTzs = calculateCartTotal(cartItems) - couponDiscount
  if (totalTzs < 100) throw new Error('Jumla ya bei lazima iwe zaidi ya TZS 100')

  // Tengeneza order na items zote kwenye transaction moja
  const order = await prisma.$transaction(async (tx) => {
    const newOrder = await tx.order.create({
      data: {
        userId,
        totalTzs: Math.max(totalTzs, 100),
        status: 'pending',
        paymentMethod: 'wallet',
        couponId,
        couponDiscount: couponDiscount || null,
        items: {
          create: cartItems.map(item => {
            const product = item.product
            const tzs = isDiscountActive(product) ? product.discountTzs : product.priceTzs
            const usd = isDiscountActive(product) ? product.discountUsd : product.priceUsd
            return {
              productId: product.id,
              priceTzsAtPurchase: tzs,
              priceUsdAtPurchase: usd || 0.0,
              quantity: item.quantity,
            }
          }),
        },
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
      },
    })

    return newOrder
  })

  logger.info('Order created', {
    orderId: order.id,
    userId,
    totalTzs: order.totalTzs,
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
      priceTzs: true,
      priceUsd: true,
      discountTzs: true,
      discountUsd: true,
      discountStartsAt: true,
      discountEndsAt: true,
      stock: true,
      productType: true,
    },
  })

  if (!product) throw new Error('Bidhaa haipatikani')
  if (product.stock !== null && product.stock < 1) throw new Error('Bidhaa imekwisha')

  const tzs = isDiscountActive(product) ? product.discountTzs : product.priceTzs
  const usd = isDiscountActive(product) ? product.discountUsd : product.priceUsd
  const totalTzs = Math.max(tzs - couponDiscount, 100)

  const order = await prisma.order.create({
    data: {
      userId,
      totalTzs,
      status: 'pending',
      paymentMethod: 'wallet',
      couponId,
      couponDiscount: couponDiscount || null,
      items: {
        create: [{
          productId: product.id,
          priceTzsAtPurchase: tzs,
          priceUsdAtPurchase: usd || 0.0,
          quantity: 1,
        }],
      },
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
    },
  })

  logger.info('Direct order created', { orderId: order.id, userId, productId, totalTzs })
  return order
}

// ─── Wallet Payment Checkout ─────────────────────────────────

/**
 * Lipia order kwa kutumia Salio la Wallet
 *
 * @param {number} userId - User Database ID
 * @param {number} orderId - Order ID
 */
async function payOrderWithWallet(userId, orderId) {
  return prisma.$transaction(async (tx) => {
    // 1. Pata na kagua order
    const order = await tx.order.findFirst({
      where: { id: orderId, userId, status: 'pending' },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                stock: true,
                isActive: true,
              },
            },
          },
        },
      },
    })

    if (!order) {
      throw new Error('Order haipatikani au tayari ilishalipiwa')
    }

    // 2. Kagua stock za bidhaa tena
    for (const item of order.items) {
      const product = item.product
      if (!product.isActive) {
        throw new Error(`Bidhaa "${product.name}" haipo tena active`)
      }
      if (product.stock !== null && product.stock < item.quantity) {
        throw new Error(`Bidhaa "${product.name}" imekwisha stock (zilizobaki: ${product.stock})`)
      }
    }

    // 3. Debit wallet ya mtumiaji
    const transactionId = `W_PAY_${order.id}_${Date.now()}`
    const wallet = await tx.wallet.findUnique({ where: { userId } })
    if (!wallet || wallet.balance < order.totalTzs) {
      throw new Error(`Salio lako halitoshi. Inahitajika: TZS ${order.totalTzs.toLocaleString('en-US')}`)
    }

    // Punguza salio la wallet
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: order.totalTzs } },
    })

    // Unda transaction record kwenye wallet_transactions
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -order.totalTzs,
        type: 'purchase',
        status: 'completed',
        referenceId: String(order.id),
        completedAt: new Date(),
      },
    })

    // 4. Update order na kuongeza sales count / kupunguza stock
    const updatedOrder = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'paid',
        paymentMethod: 'wallet',
        paymentReference: transactionId,
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

    // Hifadhi record kwenye table ya payments pia kwa ajili ya audit
    await tx.payment.create({
      data: {
        orderId: order.id,
        gateway: 'wallet',
        telegramChargeId: transactionId,
        amountTzs: order.totalTzs,
        status: 'completed',
      },
    })

    // Sasisha stock na sales count
    for (const item of order.items) {
      if (item.product.stock !== null) {
        await tx.product.update({
          where: { id: item.product.id },
          data: {
            stock: { decrement: item.quantity },
            salesCount: { increment: item.quantity },
          },
        })
      } else {
        await tx.product.update({
          where: { id: item.product.id },
          data: { salesCount: { increment: item.quantity } },
        })
      }
    }

    // Sasisha coupon usage kama ipo
    if (order.couponId) {
      await tx.coupon.update({
        where: { id: order.couponId },
        data: { usedCount: { increment: 1 } },
      })
    }

    logger.payment({
      event: 'ORDER_PAID_WALLET',
      orderId: order.id,
      userId,
      totalTzs: order.totalTzs,
    })

    return updatedOrder
  })
}

// ─── Status Management ────────────────────────────────────────

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

  if (Math.abs(paymentAmount - order.totalTzs) > 500) {
    reasons.push(`Amount mismatch: expected ${order.totalTzs}, got ${paymentAmount}`)
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
      expectedAmount: order.totalTzs,
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
  payOrderWithWallet,
  markOrderDelivered,
  adminManualConfirm,
  cancelOrder,
  getUserOrders,
  getOrderById,
  adminGetOrders,
  checkFraud,
}
