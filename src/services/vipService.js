'use strict'

const { prisma } = require('../database')
const logger = require('../utils/logger')
const config = require('../config')

/**
 * Nunua au ongeza muda wa uanachama wa VIP
 *
 * @param {number} userId - Database User ID
 * @param {number} days - Siku za kujiunga (mfano: 30)
 */
async function purchaseVip(userId, days = 30) {
  const price = config.vip.priceTzs || 10000

  logger.info('User attempting to purchase VIP', { userId, days, price })

  return prisma.$transaction(async (tx) => {
    // 1. Kagua mtumiaji na wallet yake
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, isVip: true, vipExpiresAt: true },
    })

    if (!user) {
      throw new Error('Mtumiaji hajapatikana')
    }

    const wallet = await tx.wallet.findUnique({ where: { userId } })
    if (!wallet || wallet.balance < price) {
      throw new Error(`Salio lako la wallet halitoshi kununua VIP. Inahitajika TZS ${price.toLocaleString('en-US')}`)
    }

    // 2. Kata fedha kwenye wallet
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: price } },
    })

    // Unda transaction record
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -price,
        type: 'purchase',
        status: 'completed',
        referenceId: `VIP_SUB_${Date.now()}`,
        completedAt: new Date(),
      },
    })

    // 3. Piga hesabu ya tarehe ya kuisha
    let newExpiresAt = new Date()
    if (user.isVip && user.vipExpiresAt && user.vipExpiresAt > new Date()) {
      newExpiresAt = new Date(user.vipExpiresAt)
    }
    newExpiresAt.setDate(newExpiresAt.getDate() + days)

    // 4. Update user profile to VIP
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        isVip: true,
        vipExpiresAt: newExpiresAt,
      },
    })

    logger.info('User purchased VIP successfully', { userId, newExpiresAt })
    return updatedUser
  })
}

/**
 * Kagua kama muda wa VIP wa mtumiaji umekwisha na usasishe
 * Inaitwa wakati wa start au profile view
 */
async function checkVipExpiry(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isVip: true, vipExpiresAt: true },
  })

  if (!user || !user.isVip) return false

  if (user.vipExpiresAt && user.vipExpiresAt < new Date()) {
    logger.info('User VIP expired', { userId, expiredAt: user.vipExpiresAt })
    await prisma.user.update({
      where: { id: userId },
      data: { isVip: false },
    })
    return true
  }

  return false
}

module.exports = {
  purchaseVip,
  checkVipExpiry,
}
