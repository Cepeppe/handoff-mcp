# Text mode

Text mode is what the server does when nothing is listening on the local socket. It is not a
failure path bolted on afterwards: it is the reason the server is usable on its own, in any
MCP client, with nothing else installed.

An open call returns `status: "text_mode"` with the validated spec rendered as text in
`spec_text`. The agent presents it in the chat, walks the person through the steps one at a
time, and collects the result in the conversation. That is the whole mode.

## What it looks like

```json
{
  "outcome_version": 1,
  "handoff_id": null,
  "status": "text_mode",
  "final": false,
  "instruction": "The overlay app is not running. Present the spec in spec_text to the user in chat, walk them through the steps one at a time, and collect the result in chat. Nothing is logged and no verified state exists in this mode: there is no handoff to resume and no verification to report.",
  "app_reachable": false,
  "spec_text": "…"
}
```

and `spec_text` is:

```text
# Handoff (text mode): Register the Stripe webhook for payment events
Where: Stripe Dashboard → Developers → Webhooks  [https://dashboard.stripe.com/webhooks]
Why a person: Requires access to the production Stripe account.
Values (from the project):
  - endpoint_url: https://api.myapp.example/webhooks/stripe
  - events: checkout.session.completed, invoice.paid
Steps:
  1. Click Add endpoint and paste the endpoint URL.   (values: endpoint_url)
  2. Select the events checkout.session.completed and invoice.paid.   (values: events)
  3. Save and copy the signing secret.
  4. Paste it into .env as STRIPE_WEBHOOK_SECRET.
After the steps, the user copies these values into project files (never paste them in chat):
  - STRIPE_WEBHOOK_SECRET → .env
Verification you must perform afterwards: Check that STRIPE_WEBHOOK_SECRET exists in .env without reading its value, then send a test event from the dashboard and verify it reaches /webhooks/stripe with a valid signature.
```

The exact rendering is [`fixtures/outcomes/text-mode.json`](../fixtures/outcomes/text-mode.json),
which is generated from the renderer and checked against it by a test.

## The limitations, stated plainly

**There is no log.** Nothing about the handoff is written anywhere by anybody. What happened
exists only in the chat transcript.

**There is no "verified" state.** No handoff record exists, so no state can be set on one.
The agent may still check its own work and say so in the conversation, but that is a sentence
in a chat, not the `verified` of [the outcome format](outcome.md). Nothing is recorded, and
no runbook is saved.

**There is nothing to resume.** `handoff_id` is null, because no id was minted: no state
exists anywhere to attach one to. Calling `handoff_to_user` with `resume`, or with
`handoff_id` and a `reply`, or calling `handoff_verify`, all answer
[`APP_DISCONNECTED`](errors.md) instead — there is nothing on the other side to continue.

**There is no screenshot path**, no step-by-step panel, no deferral, no parking and no
end-of-turn safety net. The steps are text in a conversation, and the person reads them there.

**Values that matched a certain-secret pattern are masked** in `spec_text`, exactly as they
are everywhere else: `- api_key: [treated as secret: api_key]`. The mask names the family,
not the pattern that matched, so it does not announce which vendor issued the secret.

## When it happens

- No overlay application is installed, or it is not running. This is the ordinary case for
  anyone using the npm package on its own, and it is fully supported.
- The overlay refused the connection token, or speaks a different channel protocol version.
  The outcome is the same `text_mode` outcome, with the reason and what to do about it added
  as a second text block of the tool result.
- **A remote agent** — an agent running in a cloud rather than on the person's machine —
  finds no socket, because there is no socket to find on a machine the person is not sitting
  at. This works with no extra code, and it is _not supported_: everything above applies, and
  there is no overlay on the other end to change that.

A call that was already blocking when the connection dropped does not fall back: it waits for
the channel to come back and re-attaches. Only a new open degrades.

## Using it deliberately

Text mode is a reasonable way to use `handoff-mcp` on its own. What it buys you over writing
the same instructions by hand is the part that is easy to get wrong: a validated spec, one
step at a time in a fixed order, values named and separated from prose, secrets masked before
they can be pasted anywhere, and a `verify` sentence you have committed to running afterwards.

What it does not buy you is memory. If you want a log, a verified state and saved runbooks,
something has to be listening on the socket.
