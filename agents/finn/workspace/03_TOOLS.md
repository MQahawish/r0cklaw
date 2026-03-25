# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, craft.sh, talk.sh, leave_message.sh, or pray.sh to perform them.
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

## Economic actions

- `pay`: use `target` and `amount`
  Example JSON: `{"action":"pay","target":"Marcus Hale","amount":10,"duration_ticks":1}`
- `buy`: use `target`, `item`, `quantity`, optional `amount`
  Example JSON: `{"action":"buy","target":"Marcus Hale","item":"coal","quantity":3,"amount":12,"duration_ticks":1}`
- `sell`: use `target`, `item`, `quantity`, optional `amount`
  Example JSON: `{"action":"sell","target":"Finn","item":"horseshoe","quantity":2,"amount":62,"duration_ticks":1}`
- `give`: use `target`, `item`, `quantity`
  Example JSON: `{"action":"give","target":"Cora","item":"bread","quantity":1,"duration_ticks":1}`
- `trade`: use `target`, `offer`, `request`
  Example JSON: `{"action":"trade","target":"Marcus Hale","offer":[{"item":"horseshoe","quantity":1}],"request":[{"item":"coal","quantity":2}],"duration_ticks":1}`

## Act in the world

- `talk`: use `target` and `text`
  Example JSON: `{"action":"talk","target":"Marcus Hale","text":"I need coal by Day 9.","duration_ticks":1}`
- `move`: use `location`
  Example JSON: `{"action":"move","location":"market","duration_ticks":1}`
- `eat`: use `item`, optional `quantity`
  Example JSON: `{"action":"eat","item":"bread","quantity":1,"duration_ticks":1}`
- `rest`: no extra fields beyond `duration_ticks`
- `sleep`: no extra fields beyond `duration_ticks`; use it when ending the day
- `observe`: prefer `topic` when you know what you are checking
  Example JSON: `{"action":"observe","topic":"village_news","duration_ticks":1}`
- `write`: use `target` and `text`
  Example JSON: `{"action":"write","target":"self/plans.md","text":"Need more coal before tomorrow.","duration_ticks":1}`

## Speaking into the world

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.

## Messages

Use `leave_message` with `target` and `text`.
Example JSON: `{"action":"leave_message","target":"Marcus Hale","text":"Marcus, I need 3 coal before Day 8. I can pay 12 coin. -- Elena","duration_ticks":1,"thought":"Leave terms Marcus can act on later."}`
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
