export function getSeedTransactions() {
  return [
    {
      external_id: 'ORD-1001',
      price: { total: 89.99 },
      products: [
        { name: 'Diamond Ring', quantity: 1 },
        { name: 'Leather Wallet', quantity: 1 },
      ],
    },
    {
      external_id: 'ORD-1002',
      price: { total: 15.50 },
      products: [
        { name: 'Fresh Baked Bread', quantity: 3 },
        { name: 'Apple Juice', quantity: 2 },
      ],
    },
    {
      external_id: 'ORD-1003',
      price: { total: 42.00 },
      products: [
        { name: 'Camping Lantern', quantity: 1 },
        { name: 'Fishing Rod', quantity: 1 },
        { name: 'Compass', quantity: 1 },
      ],
    },
  ];
}