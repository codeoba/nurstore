'use strict'

const { prisma } = require('../database')
const logger = require('../utils/logger')

/**
 * Pata au unda wallet ya mtumiaji
 * @param {number} userId - Database User ID
 */
async function getOrCreateWallet(userId) {
  return prisma.wallet.upsert({
    where: { userId },
    update: {},
    create: { userId, balance: 0 },
  })
}

/**
 * Ongeza salio kwenye wallet (Credit)
 *
 * @param {number} userId - User ID
 * @param {number} amount - Kiasi cha kuongeza (TZS)
 * @param {string} type - "deposit" | "referral_commission"
 * @param {string} gateway - "binance_pay" | "telegram_provider" | "manual"
 * @param {string} referenceId - Muamala au charge ID
 * @param {object} metadata - Data za ziada za muamala
 */
async function creditWallet(userId, amount, type, gateway, referenceId, metadata = {}) {
  if (amount <= 0) throw new Error('Kiasi lazima kiwe zaidi ya 0')

  logger.info('Crediting wallet', { userId, amount, type, gateway, referenceId })

  return prisma.$transaction(async (tx) => {
    // Pata au unda wallet
    const wallet = await tx.wallet.upsert({
      where: { userId },
      update: { balance: { increment: amount } },
      create: { userId, balance: amount },
    })

    // Unda transaction record
    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount,
        type,
        status: 'completed',
        gateway,
        referenceId,
        metadata: metadata ? JSON.stringify(metadata) : null,
        completedAt: new Date(),
      },
    })

    return { wallet, transaction }
  })
}

/**
 * Punguza salio kwenye wallet kwa ununuzi (Debit)
 *
 * @param {number} userId - User ID
 * @param {number} amount - Kiasi cha kupunguza (TZS)
 * @param {string} type - "purchase"
 * @param {string} referenceId - Order ID au reference
 * @param {object} metadata - Data za ziada
 */
async function debitWallet(userId, amount, type = 'purchase', referenceId = null, metadata = {}) {
  if (amount <= 0) throw new Error('Kiasi lazima kiwe zaidi ya 0')

  logger.info('Debiting wallet', { userId, amount, type, referenceId })

  return prisma.$transaction(async (tx) => {
    // Pata wallet
    let wallet = await tx.wallet.findUnique({ where: { userId } })
    if (!wallet) {
      // Unda ikiwa haipo lakini balance ni 0 hivyo itashindwa
      wallet = await tx.wallet.create({ data: { userId, balance: 0 } })
    }

    if (wallet.balance < amount) {
      throw new Error(`Salio lako halitoshi. Salio la sasa: TZS ${wallet.balance.toLocaleString('en-US')}`)
    }

    // Punguza salio
    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: amount } },
    })

    // Unda transaction record
    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -amount, // Hifadhi kama negative
        type,
        status: 'completed',
        referenceId,
        metadata: metadata ? JSON.stringify(metadata) : null,
        completedAt: new Date(),
      },
    })

    return { wallet: updatedWallet, transaction }
  })
}

/**
 * Pata historia ya miamala ya mtumiaji
 */
async function getTransactions(userId, limit = 5) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: { id: true },
  })

  if (!wallet) return []

  return prisma.walletTransaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

module.exports = {
  getOrCreateWallet,
  creditWallet,
  debitWallet,
  getTransactions,
}
