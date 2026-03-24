# How to Interact with Rocklaw

All interaction with the world happens through these commands.
You cannot do anything not on this list.

Your world/ files are always up to date when you wake up.
You do not need to refresh them -- they were updated before your tick.

## Search your deep memory

recall.sh "<query>"
  Searches your full memory for relevant past events.
  Use when something feels familiar but is not in your current files.
  Example: recall.sh "marcus coal trade"
  Example: recall.sh "last time grain was scarce"

## Economic actions

pay.sh <agent> <amount>
  Hand coin to someone. No conditions.
  Example: pay.sh marcus 10

buy.sh <agent> <item> <qty>
  Purchase from someone at your location.
  Example: buy.sh marcus coal 3

sell.sh <agent> <item> <qty>
  Sell to someone at your location.
  Example: sell.sh finn horseshoe 2

give.sh <agent> <item> <qty>
  Give something freely, no payment expected.
  Example: give.sh cora bread 1

trade.sh <agent> <give_item> <give_qty> <want_item> <want_qty>
  Propose a trade to someone at your location.
  Example: trade.sh marcus iron_ore 3 coin 6

## Act in the world

talk.sh <agent> "<message>"
  Speak to someone. They must be at your location.
  Example: talk.sh marcus "I need coal by Day 9."

move.sh <location>
  Walk somewhere. Takes time.
  Locations: forge, market, inn, farm, shrine, gate, square
  Example: move.sh market

eat.sh <item>
  Consume food from your inventory.
  Example: eat.sh bread

rest.sh
  Rest in place. Restores partial energy. Takes time.

sleep.sh
  End your day. Fully restores energy. Always run this last.

## Speaking into the world

pray.sh "<message>"
  Sometimes there are things you want to say with nowhere to go.
  Example: pray.sh "I don't know if the harvest will come."

## Messages

leave_message.sh <agent> "<message>"
  Leave a note at your current location for someone.
  They find it the next time they visit here.
  Write the letter content directly as the second argument.
  Example: leave_message.sh elena "Elena, I have 5 coal in stock. Come trade when you are ready. -- Marcus"


## Merchant skills

negotiate.sh <agent> <item> <qty> <offer_price>
  Propose a custom price. Better than buy/sell for large deals.
  Example: negotiate.sh elena iron_ore 10 50

post_price.sh <item> <price>
  Advertise a buying or selling price on the market board.
  Example: post_price.sh grain 10

bulk_buy.sh <agent> <item> <qty>
  Purchase a large quantity at once. May get a discount.
  Example: bulk_buy.sh finn grain 20

appraise.sh <item>
  Estimate the true value of goods or services.
  Example: appraise.sh axe
