# How to Interact with Rocklaw

## Runtime rule

These notes describe the kinds of actions that exist in Rocklaw.
In ZeroClaw session mode, do NOT run shell commands like move.sh, work.sh, talk.sh, or pray.sh to perform them.
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

## Economic actions

Runtime availability for your role will be listed here each tick.

## Act in the world

- Do not use `observe`, `inspect`, `look`, or `survey` as a final world action. Observation is done through file reads and notes during tool use.
- Do not invent placeholder values in JSON. Never put strings like `"None"`, `"null"`, `"unknown"`, or `<placeholder>` into `target`, `offer_ref`, `item`, or other optional fields. Omit the field instead.
- Only use `chat` with `intent:"accept_transaction"` or `intent:"reject_transaction"` when `TURN.md` shows a real pending offer with a concrete `offer_ref`.
- If `ONLINE`, live scenes, and known thread contacts are empty, do not target a person. Choose a non-chat action instead.
- Do not infer a person from a role need alone. Needing a blacksmith, farmer, merchant, or healer does not make someone a valid target unless `TURN.md` currently shows them as a real contact.

- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread.
  Example JSON: `{"action":"chat","target":"<known contact from TURN.md>","text":"Do you still have coal?"}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"<current live chat partner>","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- `move`: use `location` and choose only from `Reachable places now` in `TURN.md`.
  Example JSON: `{"action":"move","location":"market"}`
- `buy_place`: buy stock directly from the place you are standing in at the local price shown in `TURN.md`.
  Example JSON: `{"action":"buy_place","target":"market","item":"coal","quantity":3}`
- `sell_place`: sell stock directly into the place you are standing in at the local price shown in `TURN.md`.
  Example JSON: `{"action":"sell_place","target":"bakery","item":"grain","quantity":4}`
- `deliver_place`: move your own stock into a place without immediate payment. This is storage or supply, not a sale.
  Example JSON: `{"action":"deliver_place","target":"warehouse","item":"coal","quantity":5}`

## Speaking into the world

- `say`: use `text` to speak out loud in your current location. This is local speech, not a thread, and it does not take a target.
  Example JSON: `{"action":"say","text":"Fresh bread at the inn if anyone wants some."}`

If you want to pray, return a final JSON action with `"action": "pray"` and put the prayer text in `text`.
