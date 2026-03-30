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

## Act in the world

- Do not use `observe`, `inspect`, `look`, or `survey` as a final world action. Observation is done through file reads and notes during tool use.
- Do not invent placeholder values in JSON. Never put strings like `"None"`, `"null"`, `"unknown"`, or `<placeholder>` into `target`, `offer_ref`, `item`, or other optional fields. Omit the field instead.
- Only use `chat` with `intent:"accept_transaction"` or `intent:"reject_transaction"` when `TURN.md` shows a real pending offer with a concrete `offer_ref`.
- If `ONLINE`, live scenes, and known thread contacts are empty, do not target a person. Choose a non-chat action instead.
- Do not infer a person from a role need alone. Needing a blacksmith, farmer, merchant, or healer does not make someone a valid target unless `TURN.md` currently shows them as a real contact.

- `chat`: use `target` and `text`; if the other person is here it becomes a live chat, otherwise it becomes a deferred chat in their CHAT thread
  Choose a real target from `ONLINE`, first-seen nearby people, current live scenes, or known thread contacts in `TURN.md`. Do not invent a person just because they appear in an example.
  Example JSON: `{"action":"chat","target":"<known contact from TURN.md>","text":"I need coal by Day 9."}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"<current live chat partner>","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`

- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`
- For `intent:"trade"`, natural-language text alone is invalid. You must include both `offer` and `request` arrays.
  Example JSON: `{"action":"chat","target":"Lena Marsh","text":"Would you trade three bread for one medicine?","intent":"trade","offer":[{"item":"bread","quantity":3}],"request":[{"item":"medicine","quantity":1}]}`

- `chat`: continue your live chat with Elena Voss. Use the same target until you leave the scene.
  Example JSON: `{"action":"chat","target":"Elena Voss","text":"Makes sense."}`

- `chat` with `intent`: buy, sell, trade, give, pay, accept, or reject through the same spoken turn.
  Example JSON: `{"action":"chat","target":"Elena Voss","text":"I can sell you one horseshoe for 35 coin.","intent":"sell","item":"horseshoe","quantity":1,"amount":35}`

- `leave_chat`: leave the live chat. You may include `text` for a final goodbye line.
  Example JSON: `{"action":"leave_chat","text":"All right, chat later.","thought":"I need to end this conversation now."}`

- Each live-chat turn must make progress: answer the partner's last question, ask one direct question, make one concrete offer, respond to a pending offer with the exact structured fields, or leave the chat.
- Do not repeat the same point, do not restate the same offer twice, and never output filler like `...` or `waiting for your response`.
