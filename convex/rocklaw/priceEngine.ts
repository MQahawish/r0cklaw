/**
 * Price Engine -- recalculates market prices based on total supply across all agents.
 * Called after any inventory-changing action.
 */

import { internalMutation } from '../_generated/server';

// Base prices and village-wide supply thresholds
const ITEM_CONFIG: Record<string, { basePrice: number; criticalSupply: number; moderateSupply: number }> = {
  iron_ore:  { basePrice: 6,  criticalSupply: 5,  moderateSupply: 15 },
  coal:      { basePrice: 4,  criticalSupply: 8,  moderateSupply: 20 },
  grain:     { basePrice: 8,  criticalSupply: 10, moderateSupply: 30 },
  bread:     { basePrice: 4,  criticalSupply: 5,  moderateSupply: 15 },
  horseshoe: { basePrice: 14, criticalSupply: 2,  moderateSupply: 8  },
  medicine:  { basePrice: 12, criticalSupply: 3,  moderateSupply: 10 },
  tools:     { basePrice: 18, criticalSupply: 2,  moderateSupply: 6  },
  axe:       { basePrice: 20, criticalSupply: 1,  moderateSupply: 5  },
  knife:     { basePrice: 10, criticalSupply: 2,  moderateSupply: 8  },
  herbs:     { basePrice: 6,  criticalSupply: 3,  moderateSupply: 12 },
};

export const recalculate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query('rl_agents').collect();
    const now = Date.now();

    for (const [item, config] of Object.entries(ITEM_CONFIG)) {
      // Total supply = sum across all agent inventories
      const totalSupply = agents.reduce((sum, agent) => {
        const inv = JSON.parse(agent.inventory) as Record<string, number>;
        return sum + (inv[item] ?? 0);
      }, 0);

      // Price formula: scarcity multiplier applied to base price
      let multiplier = 1.0;
      let shortageLevel: 'none' | 'moderate' | 'critical' = 'none';

      if (totalSupply <= config.criticalSupply) {
        multiplier = 2.0 + (config.criticalSupply - totalSupply) * 0.1;
        shortageLevel = 'critical';
      } else if (totalSupply <= config.moderateSupply) {
        const ratio = (totalSupply - config.criticalSupply) / (config.moderateSupply - config.criticalSupply);
        multiplier = 1.0 + (1.0 - ratio) * 1.0;
        shortageLevel = 'moderate';
      }

      const newPrice = Math.round(config.basePrice * multiplier);
      const changePct = ((newPrice - config.basePrice) / config.basePrice) * 100;

      // Upsert
      const existing = await ctx.db
        .query('rl_market_prices')
        .withIndex('item', (q) => q.eq('item', item))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, { price: newPrice, changePct, shortageLevel, lastUpdated: now });
      } else {
        await ctx.db.insert('rl_market_prices', {
          item,
          price: newPrice,
          basePrice: config.basePrice,
          changePct,
          shortageLevel,
          lastUpdated: now,
        });
      }
    }
  },
});
