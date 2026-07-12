'use strict'

const { prisma } = require('../database')
const { creditWallet } = require('./walletService')
const logger = require('../utils/logger')

/**
 * Omba refund ya order iliyolipwa
 *
 * @param {number} userId - ID ya mteja
 * @param {number} orderId - ID ya order
 * @param {string} reason - Sababu ya kuomba refund
 */
async function createRefundRequest(userId, orderId, reason, proofFileId = null, proofType = null) {
  logger.info('Attempting to create refund request', { userId, orderId, reason, proofFileId, proofType })

  // 1. Hakikisha order ipo na inamilikiwa na mteja huyu na imelipiwa/delivered
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      userId,
      status: { in: ['paid', 'delivered'] },
    },
  })

  if (!order) {
    throw new Error('Order hii haipatikani au haiwezi kuombewa refund kwa sasa.')
  }

  // 2. Hakikisha hakuna refund request ya zamani
  const existing = await prisma.refundRequest.findUnique({
    where: { orderId },
  })

  if (existing) {
    throw new Error('Tayari ulishatuma ombi la refund kwa ajili ya order hii.')
  }

  // 3. Unda request mpya
  const request = await prisma.refundRequest.create({
    data: {
      orderId,
      reason,
      status: 'pending',
      proofFileId,
      proofType,
    },
    include: {
      order: {
        include: {
          user: {
            select: {
              id: true,
              telegramId: true,
              fullName: true,
              username: true,
            },
          },
        },
      },
    },
  })

  logger.info('Refund request created successfully', { requestId: request.id, orderId })
  return request
}

/**
 * Idhinisha au kataa ombi la refund
 *
 * @param {number} requestId - ID ya Refund Request
 * @param {string} status - 'approved' au 'rejected'
 * @param {number} adminId - ID ya Admin anayeshughulikia (Audit)
 * @param {string} adminNotes - Maelezo ya admin
 */
async function resolveRefundRequest(requestId, status, adminId, adminNotes = '') {
  logger.info('Resolving refund request', { requestId, status, adminId })

  if (!['approved', 'rejected'].includes(status)) {
    throw new Error('Status isiyo sahihi. Tumia approved au rejected.')
  }

  return prisma.$transaction(async (tx) => {
    // 1. Pata request
    const request = await tx.refundRequest.findUnique({
      where: { id: requestId },
      include: {
        order: {
          select: {
            id: true,
            userId: true,
            totalTzs: true,
            status: true,
          },
        },
      },
    })

    if (!request) {
      throw new Error('Ombi la refund halipatikani.')
    }

    if (request.status !== 'pending') {
      throw new Error(`Ombi hili tayari lilishashughulikiwa. Hali: ${request.status}`)
    }

    // 2. Usasishe RefundRequest
    const updatedRequest = await tx.refundRequest.update({
      where: { id: requestId },
      data: {
        status,
        adminNotes,
        resolvedAt: new Date(),
      },
    })

    let updatedOrder = null

    // 3. Kama imeidhinishwa, badilisha status ya order na rudisha fedha kwenye Wallet ya mteja
    if (status === 'approved') {
      updatedOrder = await tx.order.update({
        where: { id: request.orderId },
        data: { status: 'refunded' },
      })

      // Rudisha fedha kwenye Wallet ya mteja
      const wallet = await tx.wallet.findUnique({
        where: { userId: request.order.userId },
      })

      if (wallet) {
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: request.order.totalTzs } },
        })

        // Log transaction history
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            amount: request.order.totalTzs,
            type: 'refund',
            status: 'completed',
            referenceId: `REFUND_${request.orderId}`,
            completedAt: new Date(),
          },
        })
      }
    } else {
      updatedOrder = await tx.order.findUnique({
        where: { id: request.orderId },
      })
    }

    logger.info('Refund request resolved successfully', { requestId, status })
    return { request: updatedRequest, order: updatedOrder, clientUserId: request.order.userId }
  })
}

module.exports = {
  createRefundRequest,
  resolveRefundRequest,
}
