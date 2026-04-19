/**
 * Seed transactions for development/testing.
 * 
 * These follow Knot's TransactionLink transaction object schema exactly.
 * Used as fallback when no merchant account is linked via the SDK.
 * 
 * In production, real transactions come from syncTransactions() in
 * DeliveryWebhook.ts via the Knot /transactions/sync endpoint.
 * 
 * @see https://docs.knotapi.com/api-reference/products/transaction-link/transaction-object
 */

export function getSeedTransactions() {
  return [
    {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      external_id: 'AMZ-114-7829364',
      datetime: new Date().toISOString(),
      url: 'https://www.amazon.com/orders/114-7829364',
      order_status: 'DELIVERED',
      shipping: {
        location: {
          address: { line1: '35 University Pl', city: 'Princeton', region: 'NJ', postal_code: '08544', country: 'US' },
          first_name: 'Jeff', last_name: 'Tseng',
        },
      },
      payment_methods: [
        { external_id: 'pm_1', type: 'CARD', brand: 'VISA', last_four: '4242', name: 'Visa ending in 4242', transaction_amount: '47.96' },
      ],
      price: {
        sub_total: '43.97',
        adjustments: [{ type: 'TAX', label: 'NJ Sales Tax', amount: '3.99' }],
        total: '47.96',
        currency: 'USD',
      },
      products: [
        { external_id: 'B07H2V7HBL', name: 'Fishing Rod Carbon Fiber Telescopic', quantity: 1, price: { unit_price: '23.99', total: '23.99' } },
        { external_id: 'B09K3WMTYP', name: 'LED Lantern Rechargeable Camping Light', quantity: 2, price: { unit_price: '9.99', total: '19.98' } },
      ],
    },
    {
      id: 'f9e8d7c6-b5a4-3210-fedc-ba0987654321',
      external_id: 'AMZ-115-9283746',
      datetime: new Date().toISOString(),
      url: 'https://www.amazon.com/orders/115-9283746',
      order_status: 'DELIVERED',
      shipping: {
        location: {
          address: { line1: '35 University Pl', city: 'Princeton', region: 'NJ', postal_code: '08544', country: 'US' },
          first_name: 'Jeff', last_name: 'Tseng',
        },
      },
      payment_methods: [
        { external_id: 'pm_1', type: 'CARD', brand: 'VISA', last_four: '4242', name: 'Visa ending in 4242', transaction_amount: '34.97' },
      ],
      price: {
        sub_total: '31.97',
        adjustments: [{ type: 'TAX', label: 'NJ Sales Tax', amount: '3.00' }],
        total: '34.97',
        currency: 'USD',
      },
      products: [
        { external_id: 'B0CXRGV123', name: 'Leather Wallet RFID Blocking Bifold', quantity: 1, price: { unit_price: '14.99', total: '14.99' } },
        { external_id: 'B08N5WRWPG', name: 'Organic Apple Juice 64oz', quantity: 1, price: { unit_price: '6.99', total: '6.99' } },
        { external_id: 'B07PJV3JPL', name: 'Hardcover Notebook Lined 200 Pages', quantity: 1, price: { unit_price: '9.99', total: '9.99' } },
      ],
    },
    {
      id: 'c3d4e5f6-a7b8-9012-cdef-ab3456789012',
      external_id: 'AMZ-116-5647382',
      datetime: new Date().toISOString(),
      url: 'https://www.amazon.com/orders/116-5647382',
      order_status: 'DELIVERED',
      shipping: {
        location: {
          address: { line1: '35 University Pl', city: 'Princeton', region: 'NJ', postal_code: '08544', country: 'US' },
          first_name: 'Jeff', last_name: 'Tseng',
        },
      },
      payment_methods: [
        { external_id: 'pm_1', type: 'CARD', brand: 'VISA', last_four: '4242', name: 'Visa ending in 4242', transaction_amount: '52.47' },
      ],
      price: {
        sub_total: '47.97',
        adjustments: [{ type: 'TAX', label: 'NJ Sales Tax', amount: '4.50' }],
        total: '52.47',
        currency: 'USD',
      },
      products: [
        { external_id: 'B09QK2Y8RW', name: 'Diamond Painting Kit 5D Full Drill', quantity: 1, price: { unit_price: '12.99', total: '12.99' } },
        { external_id: 'B0BTGKZ4PQ', name: 'Iron Skillet Cast Iron 12 inch', quantity: 1, price: { unit_price: '24.99', total: '24.99' } },
        { external_id: 'B07N4M4Q2G', name: 'Golden Honey Raw Organic 16oz', quantity: 1, price: { unit_price: '9.99', total: '9.99' } },
      ],
    },
  ];
}