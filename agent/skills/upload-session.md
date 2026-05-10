# upload-session

When a user message contains `document` blocks (PDFs), they uploaded one or
more bank/card statements. The bot batched them into the user's next text
turn alongside the typed message.

## What to do

1. Treat this as a PDF ingest. Load the `ingest-statements` skill if you
   haven't already this turn.
2. Read the user's text — it usually says which card they're for ("ingest
   these as debit", "amex statement, please add"). If missing, ASK before
   parsing — don't guess.
3. Follow the ingest workflow.

## What NOT to do

- Don't dump raw PDF text in chat. Parse, stage, commit.
- Don't reply with a summary of the file before staging — keep the chat
  message brief, the preview comes from the staging tool.
- Don't ask the user to re-upload the PDF on the next turn. The file lives
  only in this turn's context; once you've staged it, the PDF data is
  released. If staging fails badly enough that you need to retry, ask the
  user to send the file again.
