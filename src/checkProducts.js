const { prisma } = require('./database')
async function main() {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      description: true,
      priceTzs: true,
      productType: true,
    }
  })
  console.log(JSON.stringify(products, null, 2))
  process.exit(0)
}
main().catch(console.error)
