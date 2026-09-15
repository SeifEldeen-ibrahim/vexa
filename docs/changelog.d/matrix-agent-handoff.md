### Matrix acts through its own agent in the meeting chat

With the `matrix` skill on, the copilot now offers **the words** rather than an action: *"Sounds like
you want a Matrix chat for the Q4 pricing thread — want the text to send to the agent?"* On
agreement the assistant posts one line, ready to copy, addressed to the Matrix agent already sitting
in that meeting's Google Chat space. The agent does the work under its own identity.

Nothing in Vexa calls Matrix, so this needs no endpoint and no credential — it works on any
deployment where the two are in the same room. It is also the safer shape: the assistant reads an
untrusted room and here it can only phrase what it read, never act on it.

The line is bounded by what the Matrix agent actually accepts, so a proposal cannot promise something
that will do nothing when pasted. Two limits are worth knowing: **a space cannot be created** (spaces
are listed and selected), and **a task is drafted, not created** — Matrix answers with a draft
somebody approves there. `MATRIX_AGENT_HANDLE` sets how the agent is addressed (default
`@matrix agent`).
