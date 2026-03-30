export type PlaceMarketPolicy = {
  placeName: string;
  treasury: number;
  buySpreadPct: number;
  sellSpreadPct: number;
  targetStockRatio: number;
};

export type PlaceStockLike = {
  placeName: string;
  item: string;
  quantity: number;
  capacity?: number;
  buys: boolean;
  sells: boolean;
  bidPrice?: number;
  askPrice?: number;
};

export type DerivedPlaceQuote = {
  bidPrice: number | null;
  askPrice: number | null;
  maxAffordableQuantity: number;
  remainingCapacity: number | null;
  canCurrentlyBuy: boolean;
  canCurrentlySell: boolean;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function basePriceFor(stock: PlaceStockLike, globalPrice?: number | null) {
  if (typeof globalPrice === 'number' && globalPrice > 0) return globalPrice;
  if (typeof stock.askPrice === 'number' && stock.askPrice > 0) return stock.askPrice;
  if (typeof stock.bidPrice === 'number' && stock.bidPrice > 0) return stock.bidPrice;
  return 1;
}

export function derivePlaceQuote(
  stock: PlaceStockLike,
  market: PlaceMarketPolicy,
  globalPrice?: number | null,
): DerivedPlaceQuote {
  const base = basePriceFor(stock, globalPrice);
  const capacity = typeof stock.capacity === 'number' && stock.capacity > 0 ? stock.capacity : null;
  const fillRatio = capacity ? clamp(stock.quantity / capacity, 0, 1.5) : market.targetStockRatio;
  const shortfall = Math.max(0, market.targetStockRatio - fillRatio);
  const surplus = Math.max(0, fillRatio - market.targetStockRatio);

  const askFactor = 1 + market.sellSpreadPct + shortfall * 0.8 - surplus * 0.2;
  const bidFactor = 1 - market.buySpreadPct + shortfall * 0.45 - surplus * 0.7;

  let bidPrice = stock.buys ? Math.max(1, Math.round(base * Math.max(0.2, bidFactor))) : null;
  let askPrice = stock.sells ? Math.max(1, Math.round(base * Math.max(0.3, askFactor))) : null;

  if (bidPrice !== null && askPrice !== null && askPrice <= bidPrice) {
    askPrice = bidPrice + 1;
  }

  const maxAffordableQuantity = stock.buys && bidPrice
    ? Math.max(0, Math.floor(market.treasury / bidPrice))
    : 0;
  const remainingCapacity = capacity ? Math.max(0, capacity - stock.quantity) : null;

  return {
    bidPrice,
    askPrice,
    maxAffordableQuantity,
    remainingCapacity,
    canCurrentlyBuy: Boolean(stock.buys && bidPrice && maxAffordableQuantity > 0 && (remainingCapacity === null || remainingCapacity > 0)),
    canCurrentlySell: Boolean(stock.sells && askPrice && stock.quantity > 0),
  };
}
