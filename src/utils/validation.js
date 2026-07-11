'use strict'

const { z } = require('zod')

// ─── Product Validation ──────────────────────────────────────

const productSchema = z.object({
  name: z.string().min(2, 'Jina lazima liwe na herufi 2+').max(100, 'Jina ni refu sana'),
  description: z.string().min(10, 'Maelezo lazima yawe na herufi 10+').max(4000),
  priceStars: z.number().int().min(1, 'Bei lazima iwe Stars 1+').max(10000),
  categoryId: z.number().int().positive(),
  productType: z.enum(['file', 'text_content', 'subscription']),
  stock: z.number().int().min(0).nullable().optional(),
  discountStars: z.number().int().min(1).nullable().optional(),
})

// ─── User Input Validation ───────────────────────────────────

const supportTicketSchema = z.object({
  subject: z.string().min(3).max(100),
  message: z.string().min(10).max(2000),
})

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
})

const couponCodeSchema = z.string()
  .min(3, 'Coupon code lazima iwe na herufi 3+')
  .max(20, 'Coupon code ni ndefu sana')
  .regex(/^[A-Z0-9_-]+$/i, 'Code lazima iwe na herufi na nambari tu')

// ─── Admin Input Validation ──────────────────────────────────

const couponCreateSchema = z.object({
  code: couponCodeSchema,
  discountType: z.enum(['percentage', 'fixed_stars']),
  discountValue: z.number().int().min(1).max(10000),
  usageLimit: z.number().int().min(1).nullable().optional(),
  minStars: z.number().int().min(1).nullable().optional(),
  expiresAt: z.date().nullable().optional(),
})

const categorySchema = z.object({
  name: z.string().min(2).max(50),
  parentId: z.number().int().positive().nullable().optional(),
})

// ─── Validation Helpers ──────────────────────────────────────

/**
 * Validate na rudisha result au throw
 * @param {z.ZodSchema} schema
 * @param {any} data
 * @returns {{ success: boolean, data?: any, error?: string }}
 */
function validate(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) {
    const errors = result.error.errors.map(e => e.message).join(', ')
    return { success: false, error: errors }
  }
  return { success: true, data: result.data }
}

/**
 * Angalia kama nambari ni valid
 */
function isPositiveInt(val) {
  const num = parseInt(val, 10)
  return !isNaN(num) && num > 0 && String(num) === String(val).trim()
}

/**
 * Angalia kama Telegram ID ni valid
 */
function isValidTelegramId(val) {
  const num = parseInt(val, 10)
  return !isNaN(num) && num > 0 && num < 9999999999
}

/**
 * Sanitize maandishi ya mtumiaji (futa HTML tags na script injections)
 */
function sanitizeText(text) {
  if (!text) return ''
  return String(text)
    .replace(/<[^>]*>/g, '') // Futa HTML tags
    .replace(/[<>]/g, '')    // Futa remaining angle brackets
    .trim()
    .substring(0, 4000)      // Limit urefu
}

/**
 * Angalia kama faili ni aina inayokubalika
 */
function isAllowedFileType(filename) {
  const allowed = [
    '.pdf', '.epub', '.doc', '.docx', '.xls', '.xlsx',
    '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.mp4', '.mp3', '.wav', '.mkv', '.avi',
    '.jpg', '.jpeg', '.png', '.gif', '.svg',
    '.js', '.py', '.php', '.html', '.css', '.txt', '.md',
    '.apk', '.exe', '.dmg',
  ]
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
  return allowed.includes(ext)
}

/**
 * Parse nambari kutoka kwa input ya mtumiaji
 * @returns {number|null}
 */
function parseNumber(input) {
  const num = parseInt(String(input).trim(), 10)
  return isNaN(num) ? null : num
}

/**
 * Parse boolean kutoka kwa input
 */
function parseBoolean(input) {
  const truthy = ['yes', 'ndiyo', 'ndio', '1', 'true', 'ok', '✅']
  return truthy.includes(String(input).toLowerCase().trim())
}

module.exports = {
  productSchema,
  supportTicketSchema,
  reviewSchema,
  couponCodeSchema,
  couponCreateSchema,
  categorySchema,
  validate,
  isPositiveInt,
  isValidTelegramId,
  sanitizeText,
  isAllowedFileType,
  parseNumber,
  parseBoolean,
}
