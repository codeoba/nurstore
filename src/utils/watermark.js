'use strict'

/**
 * Watermark ya maandishi kwa kutumia zero-width characters
 *
 * Mbinu: tunaweka mfuatano wa Zero Width Space (U+200B) na Zero Width Joiner (U+200D)
 * zinazowakilisha binary encoding ya order ID au user ID.
 * Zinabaki zisizoonekana kwa msomaji lakini zinaweza kutambuliwa kwa programu.
 *
 * MUHIMU: Hii inasaidia kujua kama maudhui yamevujishwa na ni nani alifanya hivyo.
 */

const ZERO_WIDTH_SPACE = '\u200B'   // 0 bit
const ZERO_WIDTH_JOINER = '\u200D'  // 1 bit
const SEPARATOR = '\u2060'          // Word Joiner - kutenganisha payload

/**
 * Encode nambari kama mfuatano wa zero-width characters
 * @param {number} num - Nambari ya kuencode (order_id au user_id)
 * @returns {string} Zero-width character sequence
 */
function encodeNumber(num) {
  const binary = num.toString(2).padStart(32, '0')
  return binary.split('').map(bit =>
    bit === '0' ? ZERO_WIDTH_SPACE : ZERO_WIDTH_JOINER
  ).join('')
}

/**
 * Decode mfuatano wa zero-width characters kuwa nambari
 * @param {string} encoded - Zero-width character sequence
 * @returns {number} Nambari iliyodencode
 */
function decodeNumber(encoded) {
  const binary = [...encoded].map(char => {
    if (char === ZERO_WIDTH_SPACE) return '0'
    if (char === ZERO_WIDTH_JOINER) return '1'
    return null
  }).filter(b => b !== null).join('')

  return parseInt(binary, 2)
}

/**
 * Weka watermark kwenye maandishi ya content
 *
 * Watermark inawekwa mara nyingi kwenye content:
 * - Mwanzo wa maandishi
 * - Kila baada ya maneno 50
 * - Mwisho wa maandishi
 *
 * @param {string} content - Maudhui asili ya kuuza
 * @param {number} orderId - ID ya order
 * @param {number} userId - Telegram ID ya mnunuzi
 * @returns {string} Content yenye watermark isiyoonekana
 */
function addWatermark(content, orderId, userId) {
  const orderEncoded = encodeNumber(orderId)
  const userEncoded = encodeNumber(userId)
  const watermark = `${SEPARATOR}${orderEncoded}${SEPARATOR}${userEncoded}${SEPARATOR}`

  // Weka watermark kwenye mwanzo
  let watermarked = watermark + content

  // Weka watermark kila baada ya sentensi 10 (kama content ni ndefu)
  const sentences = content.split('. ')
  if (sentences.length > 10) {
    const marked = sentences.map((sentence, index) => {
      if (index > 0 && index % 10 === 0) {
        return watermark + sentence
      }
      return sentence
    })
    watermarked = watermark + marked.join('. ')
  }

  // Weka watermark mwishoni
  watermarked += watermark

  return watermarked
}

/**
 * Toa watermark kutoka kwenye maandishi (kwa admin)
 * @param {string} content - Content yenye watermark
 * @returns {string} Content safi bila watermark
 */
function removeWatermark(content) {
  // Futa zero-width characters zote
  return content.replace(/[\u200B\u200D\u2060]/g, '')
}

/**
 * Toa taarifa za watermark kutoka kwenye maandishi
 * Inafaa kwa admin kutambua chanzo cha leak
 *
 * @param {string} content - Content iliyovujishwa
 * @returns {{ orderId: number|null, userId: number|null }}
 */
function extractWatermark(content) {
  try {
    // Tafuta watermark patterns (SEPARATOR + 32 zero-width chars + SEPARATOR)
    const pattern = new RegExp(
      `${SEPARATOR}([${ZERO_WIDTH_SPACE}${ZERO_WIDTH_JOINER}]{32})${SEPARATOR}([${ZERO_WIDTH_SPACE}${ZERO_WIDTH_JOINER}]{32})${SEPARATOR}`
    )

    const match = content.match(pattern)
    if (!match) return { orderId: null, userId: null }

    return {
      orderId: decodeNumber(match[1]),
      userId: decodeNumber(match[2]),
    }
  } catch {
    return { orderId: null, userId: null }
  }
}

/**
 * Futa zero-width chars kutoka kwa admin content preview
 * ili admin aone preview safi bila kuathiri watermark ya actual delivery
 */
function cleanForPreview(content) {
  return removeWatermark(content).substring(0, 500) + (content.length > 500 ? '...' : '')
}

module.exports = {
  addWatermark,
  removeWatermark,
  extractWatermark,
  cleanForPreview,
}
