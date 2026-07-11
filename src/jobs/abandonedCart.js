'use strict'

const { prisma } = require('../database')
const { sendAbandonedCartReminder } = require('../services/notificationService')
const logger = require('../utils/logger')

/**
 * Job worker ya kutuma reminder kwa watu walioacha cart
 * Inaitwa na BullMQ worker
 *
 * @param {import('telegraf').Telegraf} bot
 * @param {object} data - { userId? } - kama userId ipo, angalia mtumiaji mmoja tu
 */
async function abandonedCartJob(bot, data) {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000) // Carts zilizoacha zaidi ya saa 2

  // Pata users wenye cart items ambazo hazijakaguliwa/kulipiwa
  const where = data.userId ? { id: data.userId } : {}

  const usersWithCarts = await prisma.user.findMany({
    where: {
      ...where,
      isBlocked: false,
      cartItems: {
        some: {
          updatedAt: { lt: cutoff },
          notifiedAt: null, // Haijapewa reminder bado
        },
      },
    },
    select: {
      id: true,
      telegramId: true,
      fullName: true,
      language: true,
      cartItems: {
        where: { updatedAt: { lt: cutoff } },
        include: {
          product: { select: { id: true, name: true } },
        },
        take: 5,
      },
    },
    take: 100, // Fanya batch ndogo
  })

  let reminded = 0

  for (const user of usersWithCarts) {
    if (user.cartItems.length === 0) continue

    // Angalia kama mtumiaji amewahi nunua (kama ndio, usimtumie)
    const recentOrder = await prisma.order.findFirst({
      where: {
        userId: user.id,
        status: { in: ['paid', 'delivered'] },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    })

    if (recentOrder) continue // Amenunua hivi karibuni, sihitajiki reminder

    // Tuma reminder
    await sendAbandonedCartReminder(bot, user, user.cartItems)

    // Mark kama imetumwa reminder
    await prisma.cartItem.updateMany({
      where: { userId: user.id },
      data: { notifiedAt: new Date() },
    })

    reminded++

    // Punguza kasi
    await sleep(200)
  }

  logger.info('Abandoned cart job completed', { reminded, checked: usersWithCarts.length })
  return { reminded }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { abandonedCartJob }
