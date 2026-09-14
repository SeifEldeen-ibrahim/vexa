- **The in-meeting assistant is addressed as `@nexus`.** The shipped default for
  `VEXA_MEET_CHAT_PREFIX` and `DEFAULT_BOT_NAME` is now `@nexus` / `Nexus` across compose, lite and
  the helm chart, so a fresh deployment answers to the name participants actually see. One function
  owns the token: the accept hint the assistant posts (`reply "… yes"`) quotes whatever the gate
  accepts instead of its own copy, which previously told a renamed room to type a phrase the gate
  ignored. See [Interactive bots](/interactive-bots).
