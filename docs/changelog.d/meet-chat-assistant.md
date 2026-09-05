- **Choose the bot's name and force a transcription language when you send it.** The join composer
  in the Terminal grew an **Options** row: name the bot the meeting will see, and pin the language
  instead of leaving it to auto-detect. Auto-detect is unreliable on short speech windows — it will
  label English as Spanish or Portuguese — and forcing the code fixes it. `POST /bots` has always
  accepted both fields; the UI simply had no way to send them. Leaving the name blank still lets the
  deployment's own `DEFAULT_BOT_NAME` apply. See [Send a bot](/how-to/send-a-bot).
- **The assistant now answers inside the meeting chat (Google Meet).** Type `@vexa <question>` in the
  meeting chat and the answer arrives there — grounded in the live transcript, in the same
  conversation thread the Terminal's Assistant tab shows, so you can carry on in either. Opt-in per
  deployment (`VEXA_MEET_CHAT_ENABLED`), and the bot must be sent with the interactive family enabled
  (`VOICE_AGENT_ENABLED`). See [Interactive bots](/interactive-bots).
- **The bot reads and writes Google Meet chat.** Messages typed in the meeting are captured into the
  transcript alongside speech, and `POST /bots/{platform}/{native_meeting_id}/chat` — declared in the
  public API since 0.12 but never served — now sends a message into a live meeting. Reading and
  writing the meeting chat both require the bot to have been sent with `VOICE_AGENT_ENABLED`; that
  flag existed in the contract but nothing ever set it, which is why the whole interactive family
  (speak included) was unreachable. See [Interactive bots](/interactive-bots).
