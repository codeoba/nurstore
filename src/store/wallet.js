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

  // ─── Transaction History ──────────────────────────────────────
  bot.action('store:wallet:transactions', async (ctx) => {
    await ctx.answerCbQuery()
    const lang = ctx.session?.language || 'sw'
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true },
    })

    if (!user) return

    const txs = await getTransactions(user.id, 10) // Pata mwisho 10
    const usdRate = config.payments?.binance?.usdtToTzsRate || 2600

    let text = lang === 'sw' ? `📜 *Historia ya Miamala*\n\n` : `📜 *Transaction History*\n\n`

    if (txs.length === 0) {
      text += lang === 'sw' ? '_Hakuna miamala bado\\._\n' : '_No transactions yet\\._\n'
    } else {
      for (const t of txs) {
        const amtUsd = t.amount / usdRate
        const sign = t.amount > 0 ? '+' : '-'
        const absAmtUsd = Math.abs(amtUsd)
        
        let typeEmoji = '➕'
        let details = ''

        if (t.type === 'purchase') {
          typeEmoji = '🛒'
          let prodName = ''
          if (t.metadata) {
            try {
              const meta = typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata
              prodName = meta.productName || meta.name || ''
            } catch (e) {}
          }
          details = ` — Order \\#${t.referenceId || 'N/A'}${prodName ? `: ${escapeMarkdown(prodName)}` : ''}`
        } else if (t.type === 'refund') {
          typeEmoji = '↩️'
          details = ` — Refund for Order \\#${t.referenceId || 'N/A'}`
        } else if (t.type === 'referral_commission') {
          typeEmoji = '👥'
          details = ` — Referral commission`
        } else {
          // Deposit
          typeEmoji = '➕'
          details = ` — Binance Pay top\\-up`
        }

        const dateStr = t.createdAt.toISOString().split('T')[0] // YYYY-MM-DD
        
        text += `${typeEmoji} ${sign}$${escapeMarkdown(absAmtUsd.toFixed(2))}${details}\n`
        text += `_${escapeMarkdown(dateStr)}_\n\n`
      }
    }

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(lang === 'sw' ? '◀️ Rudi' : '◀️ Back', 'store:wallet')],
    ])

    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
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

  // ─── Select Gateway Callback (Manual Methods) ───────────────────
  bot.action(/^store:wallet:gateway:(binance_manual|usdt_manual|cryptobot_manual):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery()
    const gateway = ctx.match[1]
    const amountTzs = parseInt(ctx.match[2])
    const lang = ctx.session?.language || 'sw'

    if (gateway === 'cryptobot_manual') {
      await ctx.answerCbQuery(lang === 'sw' ? '🤖 CryptoBot inakuja hivi karibuni!' : '🤖 CryptoBot coming soon!', { show_alert: true })
      return
    }

    if (gateway === 'binance_manual') {
      await showBinanceManualDeposit(ctx, amountTzs, lang)
    } else if (gateway === 'usdt_manual') {
      await showUsdtManualDeposit(ctx, amountTzs, lang)
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
  const usdRate = config.payments?.binance?.usdtToTzsRate || 2600
  const balanceUsd = wallet.balance / usdRate

  const text = lang === 'sw'
    ? `💰 *Wallet Yangu*\n\n` +
      `💵 *Salio:* TZS *${wallet.balance.toLocaleString('en-US')}* \\(approx\\. $${escapeMarkdown(balanceUsd.toFixed(2))}\\)\n\n` +
      `Chagua hatua:`
    : `💰 *Your Wallet*\n\n` +
      `💵 *Balance:* TZS *${wallet.balance.toLocaleString('en-US')}* \\(approx\\. $${escapeMarkdown(balanceUsd.toFixed(2))}\\)\n\n` +
      `Choose an action:`

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(lang === 'sw' ? '💳 Weka Salio (Top Up)' : '💳 Top Up Wallet', 'store:wallet:deposit_init'),
    ],
    [
      Markup.button.callback(lang === 'sw' ? '📜 Miamala (Transactions)' : '📜 Transactions', 'store:wallet:transactions'),
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
    ? `💳 *Kuongeza Salio*\n\nChagua njia ya malipo:`
    : `💳 *Top Up Wallet*\n\nChoose a payment method:`

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        lang === 'sw' ? '🟡 Weka kwa Binance Pay' : '🟡 Top Up with Binance Pay',
        `store:wallet:gateway:binance_manual:${amountTzs}`
      ),
    ],
    [
      Markup.button.callback(
        lang === 'sw' ? '💎 Weka kwa USDT' : '💎 Top Up with USDT',
        `store:wallet:gateway:usdt_manual:${amountTzs}`
      ),
    ],
    [
      Markup.button.callback(
        lang === 'sw' ? '🤖 Weka kwa CryptoBot (Hivi Karibuni)' : '🤖 Top Up with CryptoBot',
        `store:wallet:gateway:cryptobot_manual:${amountTzs}`
      ),
    ],
    [Markup.button.callback(lang === 'sw' ? '◀️ Rudi Kwenye Wallet' : '◀️ Back to Wallet', 'store:wallet')],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

async function showBinanceManualDeposit(ctx, amountTzs, lang = 'sw') {
  const usdRate = config.payments?.binance?.usdtToTzsRate || 2600
  const usdAmount = amountTzs / usdRate
  const payId = config.payments?.binance?.payId || '263344433'

  const text = lang === 'sw'
    ? `🟡 *Top Up via Binance Pay*\n\n` +
      `🔹 *Binance ID:* \`${payId}\`\n\n` +
      `📌 *Steps:*\n` +
      `1\\. Open Binance app \\-\\> Pay \\-\\> Send\n` +
      `2\\. Enter the Binance ID above\n` +
      `3\\. Choose USDT and amount: *${escapeMarkdown(usdAmount.toFixed(2))} USDT* \\(sawa na TZS ${amountTzs.toLocaleString('en-US')}\\)\n` +
      `4\\. Confirm transfer\n` +
      `5\\. Copy the **Order ID** and send it here\\.\n\n` +
      `⏰ *Valid for 20 minutes and can only be used once\\.*\n\n` +
      `*Example Order ID:* \`402117599683977216\`\n\n` +
      `💵 Minimum deposit: *1 USDT*\n\n` +
      `*Copy the Order ID and send it here:*`
    : `🟡 *Top Up via Binance Pay*\n\n` +
      `🔹 *Binance ID:* \`${payId}\`\n\n` +
      `📌 *Steps:*\n` +
      `1\\. Open Binance app \\-\\> Pay \\-\\> Send\n` +
      `2\\. Enter the Binance ID above\n` +
      `3\\. Choose USDT and amount: *${escapeMarkdown(usdAmount.toFixed(2))} USDT* \\(approx\\. TZS ${amountTzs.toLocaleString('en-US')}\\)\n` +
      `4\\. Confirm transfer\n` +
      `5\\. Copy the **Order ID** and send it here\\.\n\n` +
      `⏰ *Valid for 20 minutes and can only be used once\\.*\n\n` +
      `*Example Order ID:* \`402117599683977216\`\n\n` +
      `💵 Minimum deposit: *1 USDT*\n\n` +
      `*Copy the Order ID and send it here:*`

  ctx.session.userWizard = {
    scene: 'wallet_deposit_manual',
    step: 'binance_order_id',
    data: { amountTzs }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'sw' ? '❌ Ghairi / Cancel' : '❌ Cancel', 'store:wallet')],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

async function showUsdtManualDeposit(ctx, amountTzs, lang = 'sw') {
  const usdRate = config.payments?.binance?.usdtToTzsRate || 2600
  const usdAmount = amountTzs / usdRate
  const trc20 = config.payments?.usdt?.trc20Address || 'TYt9SJtz3cJhnq5wgEe3N9H7fa48GvKhx5'
  const bep20 = config.payments?.usdt?.bep20Address || '0x0bacd562860a87f8fc54be1dec52fba6c47f7ed2'

  const text = lang === 'sw'
    ? `💎 *Top Up via USDT*\n\n` +
      `🔹 *TRC20 \\(USDT\\):* \`${trc20}\`\n` +
      `🔹 *BEP20 \\(USDT\\):* \`${bep20}\`\n\n` +
      `📌 *After sending the payment, send the bot the TxID (transaction hash) of your transfer\\.*\n\n` +
      `⏰ *Valid for 20 minutes and can only be used once\\.*\n\n` +
      `*Example TxID:* \`0x1234\\.\\.\\.abcd\` \\(64 chars\\)\n\n` +
      `💵 Minimum deposit: *1 USDT*\n\n` +
      `*Amount to send: ${escapeMarkdown(usdAmount.toFixed(2))} USDT* \\(approx\\. TZS ${amountTzs.toLocaleString('en-US')}\\)\n\n` +
      `*Please send the TxID here:*`
    : `💎 *Top Up via USDT*\n\n` +
      `🔹 *TRC20 \\(USDT\\):* \`${trc20}\`\n` +
      `🔹 *BEP20 \\(USDT\\):* \`${bep20}\`\n\n` +
      `📌 *After sending the payment, send the bot the TxID (transaction hash) of your transfer\\.*\n\n` +
      `⏰ *Valid for 20 minutes and can only be used once\\.*\n\n` +
      `*Example TxID:* \`0x1234\\.\\.\\.abcd\` \\(64 chars\\)\n\n` +
      `💵 Minimum deposit: *1 USDT*\n\n` +
      `*Amount to send: ${escapeMarkdown(usdAmount.toFixed(2))} USDT* \\(approx\\. TZS ${amountTzs.toLocaleString('en-US')}\\)\n\n` +
      `*Please send the TxID here:*`

  ctx.session.userWizard = {
    scene: 'wallet_deposit_manual',
    step: 'usdt_txid',
    data: { amountTzs }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(lang === 'sw' ? '❌ Cancel' : '❌ Cancel', 'store:wallet')],
  ])

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', ...keyboard })
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', ...keyboard })
  }
}

/**
 * Handle custom typed amount from user input
 * Inaitwa kwenye message router ya index
 */
async function handleWalletDepositWizard(ctx) {
  const wizard = ctx.session?.userWizard
  if (!wizard) return false

  const text = ctx.message?.text?.trim()
  const lang = ctx.session?.language || 'sw'

  // 1. Handle select amount
  if (wizard.scene === 'wallet_deposit' && wizard.step === 'amount') {
    const amountTzs = parseInt(text, 10)

    if (isNaN(amountTzs) || amountTzs < 1000 || amountTzs > 1000000) {
      await ctx.reply(
        lang === 'sw'
          ? '⚠️ Tafadhali andika kiasi sahihi cha namba kati ya TZS 1,000 na 1,000,000:'
          : '⚠️ Please type a valid number amount between TZS 1,000 and 1,000,000:'
      )
      return true
    }

    ctx.session.userWizard = { scene: 'wallet_deposit', step: 'gateway', data: { amountTzs } }
    await askGateway(ctx, amountTzs, lang)
    return true
  }

  // 2. Handle manual TxID / Order ID submission
  if (wizard.scene === 'wallet_deposit_manual') {
    const { amountTzs } = wizard.data
    const { notifyAdmins } = require('../services/notificationService')

    if (!text || text.length < 5) {
      await ctx.reply(
        lang === 'sw'
          ? '⚠️ Tafadhali weka maelezo sahihi ya muamala wako:'
          : '⚠️ Please enter valid transaction details:'
      )
      return true
    }

    ctx.session.userWizard = null // Maliza wizard

    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true },
    })

    const wallet = await getOrCreateWallet(user.id)
    const usdRate = config.payments?.binance?.usdtToTzsRate || 2600
    const usdAmount = amountTzs / usdRate

    // Unda pending transaction record kwenye DB
    const transaction = await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: amountTzs,
        type: 'deposit',
        status: 'pending',
        gateway: wizard.step === 'binance_order_id' ? 'binance_pay_manual' : 'usdt_manual',
        referenceId: text,
      },
    })

    // Notify admins with Approve/Reject buttons
    const clientName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || String(ctx.from.id)
    const methodLabel = wizard.step === 'binance_order_id' ? 'Binance Pay' : 'USDT'
    
    await notifyAdmins(
      ctx.telegram,
      `💳 *Ombi la Weka Salio (Deposit Request)\\!*\n\n` +
      `👤 Jina: ${escapeMarkdown(clientName)} \\(ID: \`${ctx.from.id}\`\\)\n` +
      `💰 Kiasi: TZS *${amountTzs.toLocaleString('en-US')}* \\(approx\\. $${escapeMarkdown(usdAmount.toFixed(2))}\\)\n` +
      `⚙️ Njia: *${methodLabel}*\n` +
      `🔑 ${wizard.step === 'binance_order_id' ? 'Binance Order ID' : 'Blockchain TxID'}: \`${escapeMarkdown(text)}\``,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Kubali (Approve)', callback_data: `admin:deposit:approve:${transaction.id}` },
              { text: '❌ Kataa (Reject)', callback_data: `admin:deposit:reject:${transaction.id}` },
            ]
          ]
        }
      }
    ).catch(() => {})

    await ctx.reply(
      lang === 'sw'
        ? '✅ *Ombi lako limepokelewa\\!*\n\nWasimamizi wanakagua malipo yako sasa hivi\\. Utapokea ujumbe salio lako likishajazwa kwenye Wallet yako\\.'
        : '✅ *Deposit Request Received\\!*\n\nOur team is verifying your payment\\. You will be notified as soon as your balance is updated\\.',
      { parse_mode: 'MarkdownV2' }
    )
    return true
  }

  return false
}

module.exports = {
  registerWalletHandlers,
  handleWalletDepositWizard,
}
