# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, craft.sh, talk.sh, leave_message.sh, or pray.sh to perform them.
Use your available tools only to inspect files, recall memory, and update your private notes.
When you are ready to act in the world, return the final Rocklaw JSON action instead.


All interaction with the world happens through these commands.
You cannot do anything not on this list.

Your world/ files are always up to date when you wake up.
You do not need to refresh them -- they were updated before your tick.

## Search your deep memory

Use your available memory recall tool when something feels familiar but is not in your current files.
Use it to search your full memory for relevant past events.

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

If you want to pray, decide on a final JSON action with "action": "pray" and put the prayer text in "message".

## Messages

leave_message.sh <agent> "<message>"
  Leave a note at your current location for someone.
  They find it the next time they visit here.
  Write the letter content directly as the second argument.
  Example: leave_message.sh lena "Lena, my knee is bad again. I will come to the shrine when I can. -- Rook"


## Retired Soldier skills

patrol.sh <location>
  Walk a watch route. You notice anything unusual.
  Example: patrol.sh square

train.sh <agent>
  Give basic fighting or discipline instruction.
  Example: train.sh cora

recall_war.sh "<topic>"
  Search your memory for military experience on a subject.
  Useful for threat assessment or historical knowledge.
  Example: recall_war.sh "siege supplies"
