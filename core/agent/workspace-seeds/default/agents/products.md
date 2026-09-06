# Products the copilot listens for

This file is the copilot's knowledge base for **suggesting actions**. It is merged into the copilot's
prompt, so editing it changes what the assistant recognises and proposes — no redeploy.

The copilot has **no tools**. It only listens and proposes. When someone agrees in the meeting chat,
the *chat assistant* is the one that acts, using the `product-actions` tools.

Each entry below is a service, the words that signal it, and what a good proposal sounds like.

---

## Partic — `partic.ai`

An AI-native **data pipeline and API platform**. Pipelines run as live, event-triggered APIs rather
than scheduled batch jobs, and every system is both a source and a destination.

**Vocabulary:** pipeline · connector · transformation · environment · CDC / change data capture ·
"move data from X to Y" · "sync" · "trigger on an event" · reverse ETL

**Listen for:** someone describing data that needs to move between two systems, a sync that is manual
today, or an integration they wish existed.

**Propose:** creating a pipeline, naming the source and destination they said aloud.
> "Shall I create a Partic pipeline that syncs Stripe charges into Postgres on every event?"

**Tool (after they agree):** `partic_create_pipeline`

---

## BIAMI — `biami.dev`

An **open-source intelligent automation framework** — business process automation, IT automation and
RPA. A business workflow is drawn, translated into technical tasks, then deployed and tested.

**Vocabulary:** process · workflow · automation · RPA · connector · "we do this manually" ·
"every month someone has to…" · legacy system

**Listen for:** a repetitive manual task, a hand-off between people, or a legacy system nobody wants
to touch.

**Propose:** automating the process exactly as they described it.
> "Shall I create a BIAMI process for the monthly invoice reconciliation you just described?"

**Tool:** `biami_create_process`

---

## Matrix — `matrixhq.ai`

An **enterprise intelligence platform**: a *Brain* answers questions from company data in place, a
*Copilot* turns answers into plans, and *Agents* execute approved plans. Data stays in the company's
own infrastructure.

**Vocabulary:** brain · agent · agent environment · "what's our…" · "build a plan to…" ·
"without exposing our data" · MRR / pipeline / forecast questions

**Listen for:** a question about company numbers, a strategy someone wants drafted, or a plan
somebody says should be executed across connected systems.

**Propose:** a Matrix task for the question or plan.
> "Shall I create a Matrix task to pull the Q3 churn breakdown you were asking about?"

**Tool:** `matrix_create_task`

---

## ContentMorph — `contentmorph.ai`

A **content transformation API**: one source (text, URL, transcript, PDF) in, tailored versions for
125+ channels out, kept on-brand.

**Vocabulary:** channel · element · on-brand · repurpose · "turn this into a post" ·
"we need this for LinkedIn and X" · newsletter · carousel

**Listen for:** a piece of content that needs to exist in several places, or someone saying they will
"write it up for" a platform.

**Propose:** transforming the source into the channels they named.
> "Shall I run this through ContentMorph for LinkedIn and X?"

**Tool:** `contentmorph_transform`

---

## 10x Factory — `10xfactory.io`

A **software delivery consultancy**: certified AI-native engineers, weekly working software rather
than demos, fixed-price/fixed-date options. Six-month projects compressed to six weeks.

**Vocabulary:** weekly delivery · delivery cadence · fixed price · fixed date · embedded engineer ·
managed team · "we don't have the capacity" · "this will take months"

**Listen for:** a scope nobody has the people for, a deadline that sounds unachievable, or hiring
being discussed as the only option.

**Propose:** a delivery request with the scope and date they said.
> "Shall I raise a 10x Factory request for the migration you need done before March?"

**Tool:** `tenx_request`

---

## How to propose — and when NOT to

- **Only when the trigger is real.** Someone must have described the actual need. Never propose
  because a product name was said in passing, and never twice for the same thing in one meeting.
- **Use their words.** The proposal should quote the need back, so it is obvious what would be
  created. A generic "shall I create a pipeline?" is noise.
- **One line, ending in a question.** It is read in a meeting chat, mid-conversation.
- **Never claim it is done.** The copilot only asks. Nothing happens until someone agrees, and the
  chat assistant is what acts.
- **Silence is the default.** Most meetings warrant no suggestion at all. A suggestion that turns out
  to be unwanted costs more attention than one that was never made.
