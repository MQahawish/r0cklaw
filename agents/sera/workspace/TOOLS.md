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
- `buy`: Available now because a trade partner is here.
- `sell`: Available now because a trade partner is here.
- `trade`: Available now because a trade partner is here.

### Unavailable here
  (none)
## Act in the world


- `move`: use `location` and choose only from `Reachable places now` in `world/location.md`
  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`
- `eat`: use `item`, optional `quantity`
  Example JSON: `{"action":"eat","item":"bread","quantity":1,"duration_ticks":1}`

## Speaking into the world

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Innkeeper skills

- Use `sell` to offer stocked food or drink directly to someone who is here.
  Example JSON: `{"action":"sell","target":"Old Rook","item":"meal","quantity":1,"amount":8,"duration_ticks":1,"thought":"A hot meal is ready and he is here at the inn."}`

- Use `buy` to restock bread, grain, or ale when inn inventory is getting thin.
  Example JSON: `{"action":"buy","target":"Finn","item":"grain","quantity":3,"amount":18,"duration_ticks":1,"thought":"The inn needs grain before meal service stalls."}`
