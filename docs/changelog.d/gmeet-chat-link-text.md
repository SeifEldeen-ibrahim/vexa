- **Google Meet chat: a message containing a link keeps its words.** The reader collected only
  elements with no children, so Meet's `<div>pull <a>https://…</a> and return the number</div>`
  yielded just the anchor: any chat message someone pasted a link into arrived as the bare URL with
  every word around it gone — transcribed that way, and unreadable to an `@vexa` assistant asked to
  act on it. A container that carries prose of its own is now read whole, while sibling elements with
  no text between them stay separate so a sender is never glued onto the body.
