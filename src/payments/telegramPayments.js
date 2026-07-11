'use strict'

const { prisma } = require('../database')
const { creditWallet } = require('../services/walletService')
const logger = require('../utils/logger')
const config = require('../config')

/**
 * Handler ya Telegram pre_checkout_query
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
    let payload
    try {
      payload = JSON.parse(query.invoice_payload)
    } catch {
      await ctx.answerPreCheckoutQuery(false, 'Ombi si sahihi. Jaribu tena.')
      return
    }

    if (payload.type !== 'deposit') {
      await ctx.answerPreCheckoutQuery(false, 'Aina ya invoice haitambuliwi.')
      return
    }

    // Thibitisha mtumiaji ni yule yule
    if (payload.userId !== query.from.id) {
      await ctx.answerPreCheckoutQuery(false, 'Mtumiaji si sahihi.')
      return
    }

    // Kagua kiasi (invoice total_amount inawakilisha cents, kwa hiyo gawa kwa 100)
    // TZS au USD mara nyingi huwa na decimal 2 kwenye Telegram
    const amountTzs = Math.round(query.total_amount / 100)
    if (amountTzs !== payload.amountTzs) {
      logger.security('PRE_CHECKOUT_AMOUNT_MISMATCH', {
        expected: payload.amountTzs,
        received: amountTzs,
        userId: query.from.id,
      })
      await ctx.answerPreCheckoutQuery(false, 'Hitilafu ya kiasi cha malipo.')
      return
    }

    // Kila kitu kiko sawa
    await ctx.answerPreCheckoutQuery(true)

    logger.payment({
      event: 'PRE_CHECKOUT_APPROVED',
      userId: query.from.id,
      amountTzs,
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
    let payload
    try {
      payload = JSON.parse(payment.invoice_payload)
    } catch {
      logger.error('Failed to parse payment payload', { payload: payment.invoice_payload })
      await ctx.reply('✅ Malipo yamepokelewa! Tafadhali wasiliana na msaada (/support) kama salio haliongezeki.')
      return
    }

    if (payload.type === 'deposit') {
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramUserId) },
        select: { id: true, fullName: true },
      })

      if (!user) {
        throw new Error('Mtumiaji hajapatikana kwenye database')
      }

      const amountTzs = payload.amountTzs

      // Unda dummy order kwa ajili ya audit trail na relation ya Payment table
      const order = await prisma.order.create({
        data: {
          userId: user.id,
          totalTzs: amountTzs,
          status: 'paid',
          paymentMethod: 'telegram_provider',
          paymentReference: payment.telegram_payment_charge_id,
          notes: `Deposit ya TZS ${amountTzs.toLocaleString('en-US')} kupitia Telegram Provider`,
          paidAt: new Date(),
        },
      })

      // Hifadhi muamala kwenye Payment table
      await prisma.payment.create({
        data: {
          orderId: order.id,
          gateway: 'telegram_provider',
          telegramChargeId: payment.telegram_payment_charge_id,
          providerChargeId: payment.provider_payment_charge_id,
          amountTzs,
          currency: payment.currency || 'TZS',
          status: 'completed',
          rawResponse: JSON.parse(JSON.stringify(payment)),
        },
      })

      // Credit wallet
      await creditWallet(
        user.id,
        amountTzs,
        'deposit',
        'telegram_provider',
        payment.telegram_payment_charge_id,
        { orderId: order.id }
      )

      await ctx.reply(
        `✅ *Malipo Yamepokelewa\\!*\n\n` +
        `Salio la *TZS ${amountTzs.toLocaleString('en-US')}* limeongezwa kwenye Wallet yako\\.\n` +
        `Tumia menu ya /start kununua bidhaa\\.`,
        { parse_mode: 'MarkdownV2' }
      )

      // Notify admins
      const { notifyAdmins } = require('../services/notificationService')
      const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(ctx.from.id)
      await notifyAdmins(
        ctx.telegram,
        `💳 *Muamala wa Kadi (Wallet Deposit)*\n\n` +
        `👤 Mteja: ${userName}\n` +
        `💰 Kiasi: TZS ${amountTzs.toLocaleString('en-US')}\n` +
        `🔗 Reference: \`${payment.telegram_payment_charge_id}\``
      ).catch(() => {})
    }
  } catch (err) {
    logger.error('Successful payment handler error', {
      error: err.message,
      telegramUserId,
      chargeId: payment.telegram_payment_charge_id,
    })
    await ctx.reply(
      '✅ Malipo yamepokelewa lakini kulitokea hitilafu ya kiufundi kuongeza salio.\n' +
      'Tafadhali wasiliana na /support ukionyesha ujumbe huu kwa msaada wa haraka.'
    ).catch(() => {})
  }
}

/**
 * Tuma invoice ya kuweka salio
 * @param {import('telegraf').Context} ctx
 * @param {number} userId - Telegram User ID
 * @param {number} amountTzs - Kiasi cha kuongeza kwa TZS
 */
async function sendDepositInvoice(ctx, userId, amountTzs) {
  const providerToken = config.payments.providerToken
  if (!providerToken) {
    throw new Error('PAYMENT_PROVIDER_TOKEN haijawekwa kwenye .env')
  }

  const payload = JSON.stringify({
    type: 'deposit',
    userId,
    amountTzs,
    timestamp: Date.now(),
  })

  // Telegram invoice inahitaji kiasi kiwe katika cents (amount * 100)
  const prices = [{ label: `Wallet Top Up (TZS ${amountTzs.toLocaleString('en-US')})`, amount: amountTzs * 100 }]

  await ctx.replyWithInvoice({
    title: 'Weka Salio (Card/Mobile Money)',
    description: `Ongeza salio la TZS ${amountTzs.toLocaleString('en-US')} kwenye wallet yako.`,
    payload,
    provider_token: providerToken,
    currency: 'TZS',
    prices,
    start_parameter: 'wallet-deposit',
  })
}

module.exports = {
  handlePreCheckout,
  handleSuccessfulPayment,
  sendDepositInvoice,
}
