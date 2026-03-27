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
  "duration_ticks": 1,
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

### Available in this live chat
- `chat + intent:"buy"`: Make a direct buy offer to Brother Aldric inside this live chat.
- `chat + intent:"sell"`: Make a direct sell offer to Brother Aldric inside this live chat.
- `chat + intent:"trade"`: Propose a barter trade with Brother Aldric inside this live chat.
- `chat + intent:"give"`: Hand goods directly to Brother Aldric while this live chat is active.
- `chat + intent:"pay"`: Pay coin directly to Brother Aldric while this live chat is active.
## Act in the world

- `chat`: continue your live chat with Brother Aldric. Use the same target until you leave the scene.
  Example JSON: `{"action":"chat","target":"Brother Aldric","text":"I understand.","duration_ticks":1}`

- `chat` with `intent`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.
  Example JSON: `{"action":"chat","target":"Brother Aldric","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35,"duration_ticks":1}`

- `leave_chat`: leave the live chat. You may include `text` for a final goodbye line.
  Example JSON: `{"action":"leave_chat","text":"Goodbye for now.","duration_ticks":1,"thought":"I need to end this conversation now."}`

- Each live-chat turn must make progress: answer the partner's last question, ask one direct question, make one concrete offer, respond to a pending offer with the exact structured fields, or leave the chat.
- Do not repeat the same point, do not restate the same offer twice, and never output filler like `...` or `waiting for your response`.

## Speaking into the world

- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.
  Example JSON: `{"action":"say","text":"Fresh bread is ready at the inn.","duration_ticks":1}`

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Herbalist skills

`gather`
  Collect herbs from the surrounding area. Time-consuming.
  Example JSON: use the `gather` action with the typed fields for this verb.

`brew`
  Prepare medicines from raw herbs. Must be at shrine or home.
  Example JSON: use the `brew` action with the typed fields for this verb.
