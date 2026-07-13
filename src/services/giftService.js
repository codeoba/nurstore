'use strict'

const { prisma } = require('../database')
const { deliverOrder } = require('./deliveryService')
const logger = require('../utils/logger')

/**
 * Mpokeaji anaclaim gift kwa kutumia code
 */
async function processGiftClaim(ctx, code) {
  const telegramUserId = ctx.from.id
  const lang = ctx.session?.language || 'sw'

  try {
    const gift = await prisma.gift.findUnique({
      where: { code },
      include: {
        order: {
          include: {
            items: {
              include: {
                product: true
              }
            }
          }
        }
      }
    })

    if (!gift) {
      await ctx.reply(lang === 'sw' ? '❌ Gift Code sio sahihi au imekosewa.' : '❌ Invalid Gift Code.')
      return
    }

    if (gift.claimedAt) {
      await ctx.reply(lang === 'sw' ? '⚠️ Zawadi hii tayari imeshatumika/imechukuliwa.' : '⚠️ This gift has already been claimed.')
      return
    }

    // Pata mtumiaji anaye claim kwenye DB yetu
    const recipient = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUserId) }
    })

    if (!recipient) {
      await ctx.reply(lang === 'sw' ? '⚠️ Tafadhali anza bot kwa kutuma /start kwanza kisha bonyeza link tena.' : '⚠️ Please start the bot first and then click the link again.')
      return
    }

    // Tuma bidhaa kwa huyu mpokeaji (tunapita deliverOrder kwa mpokeaji)
    // Sasa hivi order.userId inaonyesha aliyenunua (sender), lakini delivery itaenda kwa ctx.from.id (recipient)
    // Tutatoa confirmation message nzuri kabla
    await ctx.reply(
      lang === 'sw' 
        ? `🎁 *Hongera!*\n\nUmepokea zawadi. Bidhaa inatumwa sasa hivi...`
        : `🎁 *Congratulations!*\n\nYou've received a gift. It's being delivered now...`,
      { parse_mode: 'MarkdownV2' }
    )

    // update gift model
    await prisma.gift.update({
      where: { id: gift.id },
      data: {
        claimedAt: new Date(),
        recipientId: recipient.id,
      }
    })

    // To prevent the deliverOrder from treating this as a gift again (infinite loop), we temporarily set isGift = false in memory just for the delivery
    const deliveryOrder = { ...gift.order, isGift: false }
    
    await deliverOrder(ctx.telegram, telegramUserId, deliveryOrder)

  } catch (err) {
    logger.error('Error claiming gift', { error: err.message, code, telegramUserId })
    await ctx.reply(lang === 'sw' ? '❌ Kumetokea hitilafu.' : '❌ An error occurred.')
  }
}

module.exports = {
  processGiftClaim,
}
