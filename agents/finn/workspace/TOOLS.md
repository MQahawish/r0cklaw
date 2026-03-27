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

### Available now
- `check_field`: Available now. 2 fields here need attention.
- `plant`: Available now. At least one field is fallow and ready to plant.
- `water`: Available now. A growing field can be watered to speed it along.

### Unavailable here
- `harvest`: Unavailable now. No field is ready to harvest.
## Act in the world

- `chat`: continue your live chat with Marcus Hale. Use the same target until you leave the scene.
  Example JSON: `{"action":"chat","target":"Marcus Hale","text":"I understand.","duration_ticks":1}`

- `chat` with `intent`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.
  Example JSON: `{"action":"chat","target":"Marcus Hale","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35,"duration_ticks":1}`

- `leave_chat`: leave the live chat. You may include `text` for a final goodbye line.
  Example JSON: `{"action":"leave_chat","text":"Goodbye for now.","duration_ticks":1,"thought":"I need to end this conversation now."}`

## Speaking into the world

- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.
  Example JSON: `{"action":"say","text":"Fresh bread is ready at the inn.","duration_ticks":1}`

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Farmer skills

`harvest`
  Bring in crops from the field. Must be at farm.
  Example JSON: use the `harvest` action with the typed fields for this verb.

`plant`
  Sow seeds for the next season. Must be at farm.
  Example JSON: use the `plant` action with the typed fields for this verb.

`water`
  Tend the irrigation. Improves next harvest quality.
  Example JSON: use the `water` action with the typed fields for this verb.

`check_field`
  Inspect the crop state and estimate this season's yield.
  Must be at farm.
