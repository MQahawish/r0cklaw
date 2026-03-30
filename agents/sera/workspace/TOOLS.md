# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, craft.sh, talk.sh, or pray.sh to perform them.
Use your available tools only to inspect files, recall memory, and update your private notes.
When you are ready to act in the world, return the final Rocklaw JSON action instead.


All interaction with the world happens through JSON actions that the Rocklaw engine executes.
The legacy `.sh` names in older notes are conceptual labels only, not commands you should run.

Your world/ files are always up to date when you wake up.
You do not need to refresh them -- they were updated before your tick.

## Search your deep memory

Use your available memory recall tool when something feels familiar but is not in your current files.
Use it to search your full memory for relevant past events.

## Core action schema

Return one JSON object when you are ready to act. Use only the fields that matter.

```json
{
  "action": "...",
  "target": "optional agent name",
  "location": "optional location name",
  "text": "optional spoken or written content",
  "topic": "optional observation topic",
  "item": "optional item name",
  "quantity": 1,
  "amount": 0,
  "consumes": [],
  "produces": [],
  "offer": [],
  "request": [],
  "thought": "optional why you chose this action now",
  "message": "optional outward wording or visible framing",
  "memory_note": "optional private takeaway to remember later"
}
```

## Economic actions right now

### Available now
- `buy_place:market:bread`: Available now at market: 11 bread in stock for 7c each.
- `sell_place:market:bread`: market is buying bread for 5c each.
- `deliver_place:market:bread`: You can deliver bread into market for storage or supply without immediate payment.
- `buy_place:market:tools`: Available now at market: 1 tools in stock for 67c each.
- `buy_place:market:medicine`: Available now at market: 1 medicine in stock for 27c each.

### Unavailable here
- `sell_place:market:tools`: You do not have tools to sell into market.
- `buy_place:market:horseshoe`: market is out of horseshoe right now.
- `sell_place:market:horseshoe`: You do not have horseshoe to sell into market.
- `sell_place:market:medicine`: You do not have medicine to sell into market.
## Act in the world

- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread
  Example JSON: `{"action":"chat","target":"Marcus Hale","text":"I need coal by Day 9."}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`

- `chat`: continue your live chat with Old Rook. Use the same target until you leave the scene.
  Example JSON: `{"action":"chat","target":"Old Rook","text":"Makes sense."}`

- `chat` with `intent`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.
  Example JSON: `{"action":"chat","target":"Old Rook","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35}`

- `leave_chat`: leave the live chat. You may include `text` for a final goodbye line.
  Example JSON: `{"action":"leave_chat","text":"All right, chat later.","thought":"I need to end this conversation now."}`















## Speaking into the world

- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.
  Example JSON: `{"action":"say","text":"Fresh bread at the inn if anyone wants some."}`

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Innkeeper skills

- Use `chat` first to open a live conversation with a guest. Structured commerce is only valid while that live chat is active.

- There is no separate `craft` action for meals. Meal service happens through `chat` with `intent:"sell"` and `item:"meal"` while you are already chatting live with the guest.

- Example JSON: `{"action":"chat","target":"Marcus Hale","text":"I can make you a hot meal if you want one.","intent":"sell","item":"meal","quantity":1,"amount":8}`
