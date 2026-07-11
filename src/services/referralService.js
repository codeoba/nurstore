'use strict'

const { prisma } = require('../database')
const logger = require('../utils/logger')
const config = require('../config')

// ─── Referral Service ─────────────────────────────────────────

/**
 * Process referral kwa mtumiaji mpya
 * Anaitwa wakati mtumiaji mpya anapobofya /start na referral code
 *
 * @param {number} newUserTelegramId - Telegram ID ya mtumiaji mpya
 * @param {string} referralCode - Code ya mtu aliyemwasilisha
 */
async function processReferral(newUserTelegramId, referralCode) {
  if (!referralCode) return

  try {
    // Tafuta mwenye referral code
    const referrer = await prisma.user.findUnique({
      where: { referralCode },
      select: { id: true, telegramId: true },
    })

    if (!referrer) return // Code si sahihi

    // Angalia kama mtumiaji mpya ni tofauti na mwenye code
    const newUser = await prisma.user.findUnique({
      where: { telegramId: BigInt(newUserTelegramId) },
      select: { id: true, referredBy: true },
    })

    if (!newUser) return
    if (newUser.referredBy) return // Tayari ana referrer
    if (newUser.id === referrer.id) return // Hawezi kumwasilisha mwenyewe

    // Weka referrer kwa mtumiaji mpya
    await prisma.user.update({
      where: { id: newUser.id },
      data: { referredBy: referrer.id },
    })

    logger.info('Referral linked', {
      newUserId: newUser.id,
      referrerId: referrer.id,
      referralCode,
    })
  } catch (err) {
    logger.error('Referral processing error', { error: err.message })
  }
}

/**
 * Toa commission kwa mtu aliyemwasilisha mtumiaji aliyenunua
 * Inaitwa baada ya order kulipwa
 *
 * @param {number} buyerUserId - DB ID ya mnunuzi
 * @param {number} orderStars - Jumla ya stars za order
 */
async function awardReferralCommission(buyerUserId, orderStars) {
  try {
    const buyer = await prisma.user.findUnique({
      where: { id: buyerUserId },
      select: { referredBy: true },
    })

    if (!buyer?.referredBy) return // Hajawahi kualikwa

    const commission = config.referral.commissionStars

    // Ongeza commission kwa mwasilishaji
    await prisma.user.update({
      where: { id: buyer.referredBy },
      data: { starsEarned: { increment: commission } },
    })

    logger.info('Referral commission awarded', {
      referrerId: buyer.referredBy,
      buyerId: buyerUserId,
      commission,
    })

    return commission
  } catch (err) {
    logger.error('Commission award error', { error: err.message })
    return 0
  }
}

/**
 * Pata referral link ya mtumiaji
 */
async function getReferralLink(telegramUserId, botUsername) {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramUserId) },
    select: { referralCode: true, starsEarned: true, _count: { select: { referred: true } } },
  })

  if (!user) return null

  return {
    link: `https://t.me/${botUsername}?start=ref_${user.referralCode}`,
    code: user.referralCode,
    starsEarned: user.starsEarned,
    referredCount: user._count.referred,
  }
}

// ─── Coupon Service ───────────────────────────────────────────

/**
 * Validate na apply coupon code
 *
 * @param {string} code - Coupon code
 * @param {number} orderStars - Jumla ya stars kabla ya discount
 * @returns {{ valid: boolean, discount: number, error?: string }}
 */
async function validateCoupon(code, orderStars) {
  const coupon = await prisma.coupon.findUnique({
    where: { code: code.toUpperCase() },
  })

  if (!coupon) {
    return { valid: false, discount: 0, error: 'Code hii haipo au si sahihi' }
  }

  if (!coupon.isActive) {
    return { valid: false, discount: 0, error: 'Coupon hii imezimwa' }
  }

  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, discount: 0, error: 'Coupon hii imefika ukomo wa matumizi' }
  }

  if (coupon.expiresAt && new Date() > coupon.expiresAt) {
    return { valid: false, discount: 0, error: 'Coupon hii imekwisha muda wake' }
  }

  if (coupon.minStars && orderStars < coupon.minStars) {
    return {
      valid: false,
      discount: 0,
      error: `Coupon hii inahitaji order ya angalau ⭐ ${coupon.minStars}`,
    }
  }

  // Hesabu discount
  let discount = 0
  if (coupon.discountType === 'percentage') {
    discount = Math.floor((orderStars * coupon.discountValue) / 100)
  } else {
    discount = Math.min(coupon.discountValue, orderStars - 1) // Lazima ibaki angalau Star 1
  }

  return {
    valid: true,
    discount,
    couponId: coupon.id,
    coupon,
    description: coupon.discountType === 'percentage'
      ? `${coupon.discountValue}% punguzo`
      : `⭐ ${discount} punguzo`,
  }
}

/**
 * Unda coupon mpya
 */
async function createCoupon(data) {
  return prisma.coupon.create({
    data: {
      code: data.code.toUpperCase(),
      discountType: data.discountType,
      discountValue: data.discountValue,
      usageLimit: data.usageLimit || null,
      minStars: data.minStars || null,
      expiresAt: data.expiresAt || null,
    },
  })
}

/**
 * Pata coupons zote kwa admin
 */
async function adminGetCoupons() {
  return prisma.coupon.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { orders: true } } },
  })
}

/**
 * Zima/washa coupon
 */
async function toggleCoupon(couponId) {
  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } })
  if (!coupon) throw new Error('Coupon haipatikani')

  return prisma.coupon.update({
    where: { id: couponId },
    data: { isActive: !coupon.isActive },
  })
}

module.exports = {
  processReferral,
  awardReferralCommission,
  getReferralLink,
  validateCoupon,
  createCoupon,
  adminGetCoupons,
  toggleCoupon,
}
