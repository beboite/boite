# Home cards

A home card is a read-only status card under the composer of the new-thread
screen: a title, a status, up to six figures, a few lists of rows and a note.
A script of yours writes it. Boite reads the file and, when you ask, runs the
one command you named to rewrite it. It never reaches the data the card
describes and no model runs for it.

Desktop shows the cards under the composer; a phone shows them under the
welcome, above the composer. Nothing shows without a card, or on a core older
than this feature.

## Files

Each card is a directory in the data directory:

```text
<dataDir>/home-cards/<id>/card.json      what the card shows
<dataDir>/home-cards/<id>/refresh.json   optional: the command that writes card.json
```

`<id>` is 1 to 64 lowercase letters, digits and inner hyphens. Other names and
symbolic links are skipped. Cards are sorted by id. On Linux the data directory
is `~/.local/share/boite2` unless `BOITE_DATA_DIR` names another.

### card.json

```json
{
  "schema": 1,
  "title": { "en": "Nightly builds", "fr": "Builds de nuit" },
  "status": { "tone": "ok", "text": "All green" },
  "updatedAt": "2026-10-29T09:58:00Z",
  "stats": [
    { "label": "Passed", "value": 12, "tone": "ok" },
    { "label": "Queue", "value": "3 jobs" }
  ],
  "lists": [
    {
      "title": "Waiting",
      "items": [{ "label": "windows-arm64", "detail": "Runner offline since 08:00", "tone": "warn" }]
    }
  ],
  "note": "Shown behind the title's \"i\".\nNew lines are kept."
}
```

| Field | Rule |
| --- | --- |
| `schema` | `1` |
| `title` | Text, 60 characters |
| `status` | Optional `{ tone, text }`, text 80 characters |
| `updatedAt` | Optional ISO 8601 date of the data; the file's change time otherwise |
| `stats` | At most 6 `{ label, value, tone? }`: label 40 characters, value a number or 24 characters |
| `lists` | At most 4 `{ title, items }`, each at most 20 `{ label, detail?, tone? }`: title 40, label 60, detail 400 characters |
| `note` | Optional text, 4,000 characters |

A text is a string, or an object of texts by language with `en` required:
`{ "en": "Ready", "fr": "Prêts" }`. The app shows its own language and falls
back to English. Only a detail and the note may hold new lines.

A tone is `ok`, `warn`, `bad` or `neutral`: green, amber, red or muted. A
figure or a row without one takes the accent colour. A row's `detail` stays behind its "i"; a list shows eight rows and folds
the rest into a count.

Boite refuses a file over 64 KB, a field it does not read, and a value outside
these rules. The card then shows the file, the field and the expected value,
and the core log has the same line once.

### refresh.json

```json
{ "schema": 1, "command": ["/usr/bin/node", "/home/me/tools/builds-card.mjs"], "everyMinutes": 30 }
```

`command` is an absolute executable path, then its arguments; no shell runs
it. `everyMinutes` is 5 to 1440, or `null` to run it only from the card's
button. The command runs:

- with the card's directory as working directory, and `BOITE_HOME_CARD` set to
  the absolute path of `card.json`, the file it should write;
- through the core's process launcher, with tracing and the guards of any other
  process ([trace](trace.md));
- for 2 minutes at most, then it is stopped with what it started;
- once at a time: a second click joins the run already going.

Its output stays in the core. A client sees whether the last run succeeded,
its exit code or timeout, and when it ran. A failed run keeps the last card.

The schedule is checked every 30 seconds. A card runs again once its
interval has passed since both its last run and the last change of
`card.json`, so a card another program keeps fresh never starts the command.
Write `card.json` to a temporary file and rename it, so a scan never reads it
half-written.

## Access

`homeCards.list` and `homeCards.refresh` are open to paired devices: the list
is what the owner's screen shows, and a refresh runs only the command the
owner wrote in `refresh.json`. Neither takes a path or a command from the
client. The event `homeCards.updated` sends the whole list when a file changes
or a run starts or ends.

Keep credentials out of `card.json`: every client of the core can read it.

## Development

`?fake=1&home=1` shows one card with every part, and its button runs a fake
refresh ([development](development.md)).
