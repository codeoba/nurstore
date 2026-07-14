'use strict'

const { PDFDocument, rgb, degrees } = require('pdf-lib')
const fs = require('fs')
const logger = require('./logger')

/**
 * Add a dynamic text watermark to a PDF file for a specific user
 * @param {string} inputPath - Path to the original PDF file
 * @param {string} outputPath - Path to save the watermarked PDF file
 * @param {object} order - The order object containing user info and order ID
 * @returns {Promise<string>} - Returns the path to the watermarked PDF
 */
async function addPdfWatermark(inputPath, outputPath, order) {
  try {
    const existingPdfBytes = await fs.promises.readFile(inputPath)
    const pdfDoc = await PDFDocument.load(existingPdfBytes)

    const pages = pdfDoc.getPages()
    const watermarkText = `Purchased by: ${order.user?.fullName || order.user?.username || 'Customer'} (Order #${order.id})`

    pages.forEach((page) => {
      const { width, height } = page.getSize()

      // Add visible watermark text at the bottom center of each page
      page.drawText(watermarkText, {
        x: 50,
        y: 20,
        size: 10,
        color: rgb(0.5, 0.5, 0.5),
        opacity: 0.5,
      })

      // Add a hidden watermark diagonally across the page for extra security
      page.drawText(`Confidential ID: ${order.user?.telegramId || ''}-${order.id}`, {
        x: width / 4,
        y: height / 2,
        size: 24,
        color: rgb(0.95, 0.95, 0.95), // Very light gray, almost invisible
        opacity: 0.1,
        rotate: degrees(45),
      })
    })

    const pdfBytes = await pdfDoc.save()
    await fs.promises.writeFile(outputPath, pdfBytes)

    return outputPath
  } catch (error) {
    logger.error('Failed to add watermark to PDF', { error: error.message, inputPath, orderId: order.id })
    throw error
  }
}

module.exports = {
  addPdfWatermark,
}
