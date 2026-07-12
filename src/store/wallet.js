'use strict'

const { Markup } = require('telegraf')
const { prisma } = require('../database')
const { getOrCreateWallet, getTransactions, creditWallet } = require('../services/walletService')
const { sendDepositInvoice } = require('../payments/telegramPayments')
const { createBinanceOrder, queryBinanceOrder } = require('../payments/binancePay')
const { escapeMarkdown } = require('../utils/formatting')
const config = require('../config')
const logger = require('../utils/logger')

function registerWalletHandlers(bot) {
  // ─── Main Wallet Menu ─────────────────────────────────────────
  bot.action('store:wallet', async (ctx) => {
    await ctx.answerCbQuery()
    await showWalletMenu(ctx)
  })

  // ─── Deposit Selection ────────────────────────────────────────
  bot.action('store:wallet:deposit_init', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'

    const text = lang === 'sw'
      ? '💳 *Weka Salio \\- Chagua Kiasi:*\n\nChagua kiasi unachotaka kuongeza kwenye Wallet yako, au uandike kiasi kingine kwa kutuma ujumbe wa nambari \\(mfano: 15000\\):'
      : '💳 *Top Up \\- Select Amount:*\n\nSelect the amount you want to add to your Wallet, or type another amount by sending a number \\(example: 15000\\):'

    ctx.session.userWizard = { scene: 'wallet_deposit', step: 'amount', data: {} }

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('TZS 5,000', 'store:wallet:deposit:5000'),
        Markup.button.callback('TZS 10,000', 'store:wallet:deposit:10000'),
      ],
      [
        Markup.button.callback('TZS 20,000', 'store:wallet:deposit:20000'),
        Markup.button.callback('TZS 50,000', 'store:wallet:deposit:50000'),
      ],
      [Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', 'store:wallet')],
    ])

    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  })

  // ─── Deposit Preset Callback ──────────────────────────────────
  bot.action(/^store:wallet:deposit:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const amountTzs = parseInt(ctx.match[1])
    const lang = ctx.session?.language || 'sw'

    ctx.session.userWizard = { scene: 'wallet_deposit', step: 'gateway', data: { amountTzs } }
    await askGateway(ctx, amountTzs, lang)
  })

  // ─── Select Gateway Callback ──────────────────────────────────
  bot.action(/^store:wallet:gateway:(telegram|binance):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const gateway = ctx.match[1]
    const amountTzs = parseInt(ctx.match[2])
    const lang = ctx.session?.language || 'sw'

    ctx.session.userWizard = null // Maliza wizard

    if (gateway === 'telegram') {
      try {
        await sendDepositInvoice(ctx, ctx.from.id, amountTzs)
      } catch (err) {
        logger.error('Failed to send telegram deposit invoice', { error: err.message })
        await ctx.reply(lang === 'sw' ? '❌ Njia hii haipatikani kwa sasa.' : '❌ This payment method is currently unavailable.')
      }
    } else if (gateway === 'binance') {
      await processBinanceDeposit(ctx, amountTzs, lang)
    }
  })

  // ─── Verify Binance Payment Callback ──────────────────────────
  bot.action(/^store:wallet:confirm_binance:(DEP\w+)$/, async (ctx) => {
    const merchantTradeNo = ctx.match[1]
    const lang = ctx.session?.language || 'sw'

    await ctx.answerCbQuery(lang === 'sw' ? '🔍 Inakagua malipo...' : '🔍 Checking payment...')

    try {
      // 1. Kagua kama tayari tumesha-credit transaction hii
      const existingTx = await prisma.walletTransaction.findFirst({
        where: { referenceId: merchantTradeNo, status: 'completed' },
      })

      if (existingTx) {
        await ctx.reply(lang === 'sw' ? '✅ Muamala huu tayari ulikamilika na salio limeongezwa.' : '✅ This transaction was already completed and credited.')
        return
      }

      // 2. Query Binance Pay API
      const result = await queryBinanceOrder(merchantTradeNo)

      if (result.status === 'PAID') {
        const user = await prisma.user.findUnique({
          where: { telegramId: BigInt(ctx.from.id) },
          select: { id: true },
        })

        // Kiasi cha TZS kipo kwenye data ya metadata ya order au tunakipata kwa kupiga hesabu kurudi
        // Kwenye create tulihifadhi user na kiasi. Hebu tutafute transaction ya kwanza (pending) ili kupata TZS halisi
        const pendingTx = await prisma.walletTransaction.findFirst({
          where: { referenceId: merchantTradeNo, status: 'pending' },
        })

        const amountTzs = pendingTx ? pendingTx.amount : Math.round(result.raw.totalFee * (config.payments.binance.usdtToTzsRate || 2600))

        // Credit Wallet
        await creditWallet(
          user.id,
          amountTzs,
          'deposit',
          'binance_pay',
          merchantTradeNo,
          result.raw
        )

        // Sasisha pending transaction kama ipo
        if (pendingTx) {
          await prisma.walletTransaction.update({
            where: { id: pendingTx.id },
            data: { status: 'completed', completedAt: new Date() },
          }).catch(() => {})
        }

        await ctx.reply(
          lang === 'sw'
            ? `🎉 *Hongera\\!* Salio la *TZS ${amountTzs.toLocaleString('en-US')}* limeongezwa kwenye Wallet yako kupitia Binance Pay\\.`
            : `🎉 *Congratulations\\!* *TZS ${amountTzs.toLocaleString('en-US')}* has been credited to your Wallet via Binance Pay\\.`,
          { parse_mode: 'MarkdownV2' }
        )

        // Sasisha menu ya wallet
        await showWalletMenu(ctx).catch(() => {})
      } else {
        await ctx.reply(
          lang === 'sw'
            ? `❌ Malipo hayajapokelewa bado\\. Hali: *${result.status}*\\.\n\nBonyeza tena kitufe cha thibitisha baada ya kukamilisha muamala kwenye programu ya Binance\\.`
            : `❌ Payment not received yet\\. Status: *${result.status}*\\.\n\nClick the confirm button again after completing the transfer on Binance\\.`,
          { parse_mode: 'MarkdownV2' }
        )
      }
    } catch (err) {
      logger.error('Failed to verify Binance payment', { error: err.message, merchantTradeNo })
      await ctx.reply(lang === 'sw' ? '❌ Kushindwa kukagua muamala na Binance Pay. Jaribu tena.' : '❌ Failed to verify transaction with Binance Pay.')
    }
  })

  // ─── VIP Join Screen ──────────────────────────────────────────
  bot.action('store:vip:join_init', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true, isVip: true, vipExpiresAt: true }
    })

    const wallet = await getOrCreateWallet(user.id)
    const price = config.vip.priceTzs || 10000
    const discount = config.vip.discountPercent || 15

    let text = lang === 'sw'
      ? `👑 *Jiunge na Uanachama wa VIP\\!*\n\n` +
        `Kuwa mwanachama wa VIP wa Duka la Digital na upate faida zifuatazo:\n` +
        `• Punguzo la *${discount}%* kwa kila bidhaa dukani kiotomatiki\\.\n` +
        `• Uwezo wa kununua bidhaa za VIP Pekee \\(VIP Only\\)\\.\n` +
        `• Support ya haraka zaidi kutoka kwa wasaidizi wetu\\.\n\n` +
        `💰 *Gharama:* TZS *${price.toLocaleString('en-US')}* kwa siku 30\n` +
        `💳 Salio lako la sasa: TZS *${wallet.balance.toLocaleString('en-US')}*\n\n`
      : `👑 *Join VIP Membership\\!*\n\n` +
        `Become a VIP member of our digital store and enjoy the following benefits:\n` +
        `• Permanent *${discount}%* discount on all products\\.\n` +
        `• Access to exclusive VIP-Only products\\.\n` +
        `• Priority support from our customer care team\\.\n\n` +
        `💰 *Price:* TZS *${price.toLocaleString('en-US')}* for 30 days\n` +
        `💳 Your Balance: TZS *${wallet.balance.toLocaleString('en-US')}*\n\n`

    if (user.isVip && user.vipExpiresAt) {
      const expDate = user.vipExpiresAt.toLocaleDateString(lang === 'sw' ? 'sw-TZ' : 'en-US')
      text += lang === 'sw'
        ? `⭐ Wewe tayari ni mwanachama wa *VIP*\\. Uanachama wako utaisha tarehe *${escapeMarkdown(expDate)}*\\. Kulipia kutaongeza siku 30 zaidi\\.`
        : `⭐ You are currently a *VIP* member\\. Your membership expires on *${escapeMarkdown(expDate)}*\\. Subscribing again will add 30 more days\\.`
    }

    const payLabel = lang === 'sw'
      ? `💳 Lipia TZS ${price.toLocaleString('en-US')} kutoka Wallet`
      : `💳 Pay TZS ${price.toLocaleString('en-US')} from Wallet`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(payLabel, 'store:vip:join_confirm')],
      [Markup.button.callback(lang === 'sw' ? '◀️ Rudi Wasifu' : '◀️ Back to Profile', 'store:profile')],
    ])

    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  })

  // ─── VIP Join Confirmation ────────────────────────────────────
  bot.action('store:vip:join_confirm', async (ctx) => {
    const lang = ctx.session?.language || 'sw'

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true, username: true, fullName: true }
    })

    try {
      const { purchaseVip } = require('../services/vipService')
      const updatedUser = await purchaseVip(user.id, 30)

      await ctx.answerCbQuery(lang === 'sw' ? '🎉 Umefanikiwa kujiunga na VIP!' : '🎉 Successfully joined VIP!', { show_alert: true })

      const expDate = updatedUser.vipExpiresAt.toLocaleDateString(lang === 'sw' ? 'sw-TZ' : 'en-US')

      const text = lang === 'sw'
        ? `🎉 *Hongera sana\\!*\n\nUmekuwa mwanachama wa *VIP* wa Duka la Digital\\. Uanachama wako utaisha tarehe *${escapeMarkdown(expDate)}*\\.\n\nSasa unaweza kufurahia punguzo la ${config.vip.discountPercent}% kwenye ununuzi wako wote\\!`
        : `🎉 *Congratulations\\!*\n\nYou are now a *VIP* member of our Digital Store\\. Your membership expires on *${escapeMarkdown(expDate)}*\\.\n\nYou can now enjoy a ${config.vip.discountPercent}% discount on all your purchases\\!`

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(lang === 'sw' ? '🛍️ Angalia Bidhaa' : '🛍️ Browse Products', 'store:browse')],
        [Markup.button.callback(lang === 'sw' ? '◀️ Rudi Wasifu' : '◀️ Back to Profile', 'store:profile')],
      ])

      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })

      // Notify admins
      const { notifyAdmins } = require('../services/notificationService')
      const clientName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(ctx.from.id)
      await notifyAdmins(
        ctx.telegram,
        `👑 *Mwanachama Mpya wa VIP\\!*\n\n` +
        `👤 Jina: ${escapeMarkdown(clientName)}\n` +
        `📅 Expire date: ${escapeMarkdown(expDate)}\n` +
        `💰 Kiasi kilicholipwa: TZS ${(config.vip.priceTzs || 10000).toLocaleString('en-US')}`
      ).catch(() => {})

    } catch (err) {
      logger.error('Failed to purchase VIP', { error: err.message, userId: user.id })
      await ctx.answerCbQuery(err.message, { show_alert: true })
    }
  })
}

// ─── Help Functions ──────────────────────────────────────────

async function showWalletMenu(ctx) {
  const lang = ctx.session?.language || 'sw'
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { id: true },
  })

  if (!user) return

  const wallet = await getOrCreateWallet(user.id)
  const txs = await getTransactions(user.id, 5)

  let text = lang === 'sw'
    ? `💳 *Wallet Yangu ya TZS*\n\n` +
      `Salio la sasa: *TZS ${wallet.balance.toLocaleString('en-US')}*\n\n` +
      `📜 *Historia ya Miamala \\(Mwisho 5\\):*\n`
    : `💳 *My TZS Wallet*\n\n` +
      `Current Balance: *TZS ${wallet.balance.toLocaleString('en-US')}*\n\n` +
      `📜 *Transaction History \\(Last 5\\):*\n`

  if (txs.length === 0) {
    text += lang === 'sw' ? '_Hakuna miamala bado\\._\n' : '_No transactions yet\\._\n'
  } else {
    const typeNames = {
      deposit: lang === 'sw' ? 'Salio' : 'Deposit',
      purchase: lang === 'sw' ? 'Ununuzi' : 'Purchase',
      refund: lang === 'sw' ? 'Refund' : 'Refund',
      referral_commission: lang === 'sw' ? 'Komisheni' : 'Commission',
    }

    for (const t of txs) {
      const type = typeNames[t.type] || t.type
      const sign = t.amount > 0 ? '➕' : '➖'
      const date = t.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      text += `• \`${escapeMarkdown(date)}\` — ${escapeMarkdown(type)}: *${sign} TZS ${Math.abs(t.amount).toLocaleString('en-US')}*\n`
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(lang === 'sw' ? '➕ Weka Salio (Top Up)' : '➕ Top Up Balance', 'store:wallet:deposit_init'),
    ],
    [
      Markup.button.callback(lang === 'sw' ? '◀️ Wasifu' : '◀️ Back to Profile', 'store:profile'),
    ],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

/**
 * Onyesha menu ya chagua njia ya kulipa
 */
async function askGateway(ctx, amountTzs, lang = 'sw') {
  const text = lang === 'sw'
    ? `💰 *Kiasi cha kuweka:* TZS *${amountTzs.toLocaleString('en-US')}*\n\nChagua njia ya malipo:`
    : `💰 *Amount to Deposit:* TZS *${amountTzs.toLocaleString('en-US')}*\n\nChoose payment gateway:`

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        lang === 'sw' ? '💳 Kadi ya Bank / Simu' : '💳 Bank Card / Mobile Money',
        `store:wallet:gateway:telegram:${amountTzs}`
      ),
    ],
    [
      Markup.button.callback(
        lang === 'sw' ? '🪙 Binance Pay (USDT)' : '🪙 Binance Pay (USDT)',
        `store:wallet:gateway:binance:${amountTzs}`
      ),
    ],
    [Markup.button.callback(lang === 'sw' ? '◀️ Nyuma' : '◀️ Back', 'store:wallet:deposit_init')],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

/**
 * Shughulikia Binance Pay order creation na kutoa malipo kwa mtumiaji
 */
async function processBinanceDeposit(ctx, amountTzs, lang = 'sw') {
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true },
    })

    const orderData = await createBinanceOrder(user.id, amountTzs)

    // Weka pending transaction record ili tuifuatilie
    const wallet = await getOrCreateWallet(user.id)
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: amountTzs,
        type: 'deposit',
        status: 'pending',
        gateway: 'binance_pay',
        referenceId: orderData.merchantTradeNo,
      },
    })

    const text = lang === 'sw'
      ? `🪙 *Binance Pay Deposit \\- TZS ${amountTzs.toLocaleString('en-US')}*\n\n` +
        `Kiasi kinachotakiwa kulipwa: *${orderData.amountUsdt} USDT*\n\n` +
        `Fungua link hapo chini au bofya kitufe ili kulipa moja kwa moja kupitia programu ya Binance\\.\n\n` +
        `⚠️ *MUHIMU:* Baada ya kulipa na kuona muamala umefanikiwa kwenye Binance, bonyeza kitufe cha *Thibitisha Malipo* hapo chini kukamilisha na kupokea salio la Wallet yako\\.`
      : `🪙 *Binance Pay Deposit \\- TZS ${amountTzs.toLocaleString('en-US')}*\n\n` +
        `Amount to pay: *${orderData.amountUsdt} USDT*\n\n` +
        `Open the link below or click the button to pay directly via the Binance app\\.\n\n` +
        `⚠️ *IMPORTANT:* After paying and seeing a successful transaction on Binance, click the *Confirm Payment* button below to credit your Wallet\\.`

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.url(lang === 'sw' ? '⚡ Lipia hapa (Binance)' : '⚡ Pay here (Binance)', orderData.checkoutUrl)],
      [Markup.button.callback(lang === 'sw' ? '✅ Thibitisha Malipo' : '✅ Confirm Payment', `store:wallet:confirm_binance:${orderData.merchantTradeNo}`)],
      [Markup.button.callback(lang === 'sw' ? '❌ Ghairi' : '❌ Cancel', 'store:wallet')],
    ])

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
    } else {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
    }
  } catch (err) {
    logger.error('Failed to process binance deposit', { error: err.message })
    await ctx.reply(lang === 'sw' ? '❌ Hitilafu kuunda muamala wa Binance Pay. Jaribu tena.' : '❌ Error creating Binance Pay order. Try again.')
  }
}

/**
 * Handle custom typed amount from user input
 * Inaitwa kwenye message router ya index
 */
async function handleWalletDepositWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard || wizard.scene !== 'wallet_deposit' || wizard.step !== 'amount') return false

  const text = ctx.message?.text?.trim()
  const amountTzs = parseInt(text, 10)
  const lang = ctx.session?.language || 'sw'

  if (isNaN(amountTzs) || amountTzs < 1000 || amountTzs > 1000000) {
    await ctx.reply(
      lang === 'sw'
        ? '⚠️ Tafadhali andika kiasi sahihi cha namba kati ya TZS 1,000 na 1,000,000:'
        : '⚠️ Please type a valid number amount between TZS 1,000 and 1,000,000:'
    )
    return true
  }

  wizard.step = 'gateway'
  wizard.data.amountTzs = amountTzs

  await askGateway(ctx, amountTzs, lang)
  return true
}

module.exports = {
  registerWalletHandlers,
  handleWalletDepositWizard,
}
