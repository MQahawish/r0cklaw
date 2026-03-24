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

leave_message.sh <agent> "<file>"
  Leave a note at your current location for someone.
  They find it the next time they visit here.
  Example: leave_message.sh marcus "self/messages/outbox/to_marcus_day6.md"

## Blacksmith skills

craft.sh <item> <quantity>
  Make something. Must be at forge with materials.
  Example: craft.sh horseshoe 2

repair.sh <item>
  Repair a broken item. Must be at forge.
  Example: repair.sh axe

smelt.sh <ore> <quantity>
  Smelt ore into metal. Must be at forge.
  Example: smelt.sh iron_ore 3

appraise.sh <item>
  Assess the quality and value of an item.
  Example: appraise.sh sword
