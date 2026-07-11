'use strict'

const crypto = require('crypto')
const axios = require('axios')
const config = require('../config')
const logger = require('../utils/logger')

/**
 * Tengeneza Signature ya Binance Pay OpenAPI v3
 */
function generateSignature(timestamp, nonce, body, secretKey) {
  const payload = `${timestamp}\n${nonce}\n${body}\n`
  return crypto
    .createHmac('sha512', secretKey)
    .update(payload)
    .digest('hex')
    .toUpperCase()
}

/**
 * Tengeneza headers zote zinazohitajika kwa Binance Pay
 */
function buildHeaders(bodyObject) {
  const apiKey = config.payments.binance.apiKey
  const apiSecret = config.payments.binance.apiSecret

  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY na BINANCE_API_SECRET zinahitajika kwenye .env')
  }

  const timestamp = Date.now().toString()
  const nonce = crypto.randomBytes(16).toString('hex') // 32 characters hex string
  const bodyString = JSON.stringify(bodyObject)

  const signature = generateSignature(timestamp, nonce, bodyString, apiSecret)

  return {
    'Content-Type': 'application/json',
    'BinancePay-Timestamp': timestamp,
    'BinancePay-Nonce': nonce,
    'BinancePay-Certificate-SN': apiKey,
    'BinancePay-Signature': signature,
  }
}

/**
 * Unda malipo mapya ya Binance Pay (deposit ya TZS)
 * @param {number} userId - Database User ID
 * @param {number} amountTzs - Kiasi cha kuongeza kwa TZS
 */
async function createBinanceOrder(userId, amountTzs) {
  const usdtRate = config.payments.binance.usdtToTzsRate || 2600
  const amountUsdt = parseFloat((amountTzs / usdtRate).toFixed(2))

  // merchantTradeNo lazima iwe ya kipekee na isizidi herufi 32
  const merchantTradeNo = `DEP${Date.now()}${userId}`.substring(0, 32)

  const body = {
    env: {
      terminalType: 'APP', // APP, WEB, WAP, au MINI_PROGRAM
    },
    merchantTradeNo,
    orderAmount: amountUsdt,
    currency: 'USDT',
    description: `Wallet Deposit TZS ${amountTzs.toLocaleString('en-US')}`,
  }

  const url = `${config.payments.binance.baseUrl}/binancepay/openapi/v3/order`

  logger.info('Calling Binance Pay Create Order', { merchantTradeNo, amountUsdt, userId })

  try {
    const headers = buildHeaders(body)
    const response = await axios.post(url, body, { headers })

    if (response.data?.status !== 'SUCCESS') {
      throw new Error(response.data?.errorMessage || 'Mwamala umefeli upande wa Binance')
    }

    const data = response.data.data
    return {
      merchantTradeNo,
      prepayId: data.prepayId,
      checkoutUrl: data.checkoutUrl,
      qrContent: data.qrContent,
      amountUsdt,
    }
  } catch (err) {
    logger.error('Binance Pay order creation failed', {
      error: err.response?.data || err.message,
      userId,
    })
    throw new Error(`Imeshindwa kutengeneza invoice ya Binance: ${err.message}`)
  }
}

/**
 * Kagua hali ya malipo kwenye Binance Pay
 * @param {string} merchantTradeNo - Nambari ya mfanyabiashara ya muamala
 * @returns {Promise<{ status: string, raw: object }>} Hali ya malipo (e.g. PAID, INITIAL, PENDING)
 */
async function queryBinanceOrder(merchantTradeNo) {
  const body = { merchantTradeNo }
  const url = `${config.payments.binance.baseUrl}/binancepay/openapi/order/query`

  try {
    const headers = buildHeaders(body)
    const response = await axios.post(url, body, { headers })

    if (response.data?.status !== 'SUCCESS') {
      throw new Error(response.data?.errorMessage || 'Order query failed')
    }

    const data = response.data.data
    return {
      status: data.status, // PAID, INITIAL, PENDING, CANCELED, EXPIRED
      raw: data,
    }
  } catch (err) {
    logger.error('Binance Pay order query failed', {
      error: err.response?.data || err.message,
      merchantTradeNo,
    })
    throw new Error(`Imeshindwa kukagua malipo ya Binance: ${err.message}`)
  }
}

module.exports = {
  createBinanceOrder,
  queryBinanceOrder,
}
