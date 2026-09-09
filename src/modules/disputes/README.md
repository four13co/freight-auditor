# disputes module

`approve-dispute.ts`, `resolve-dispute.ts`, `record-dispute-communication.ts`,
`list-dispute-communications.ts`, `list-dispute-response-queue.ts`,
`create-dispute-from-findings.ts`, `get-dispute-detail.ts`, and
`validate-disputable-findings.ts` back the dispute lifecycle: create a
dispute from findings, send it, log the carrier's response, and record the
outcome. `record-dispute-communication.ts`'s `body` is a freeform string an
analyst types today.

## Evidence-packet -> statement -> prose pipeline (86e367r7r)

**Deferred: built, tested, has zero production callers.** Three files form a
documented pipeline — each docstring names the next stage:

- `build-evidence-packet.ts` assembles a dispute's full defensibility chain
  and computation trace per line.
- `render-evidence-statement.ts` deterministically renders one packet line
  into a structured `EvidenceStatement` (amount, computation, citation) —
  no AI, no free text, no recomputed numbers.
- `generate-evidence-prose.ts` turns a set of `EvidenceStatement`s into
  Claude-authored connective paragraphs around them, never replacing or
  recomputing what they assert.

All three are unit- and DB-tested but reachable from nowhere in
`src/server`: the caller that would exist — an action that assembles a
dispute's evidence packet, renders it, generates prose, and feeds the
result into `record-dispute-communication.ts`'s `body` as an
evidence-backed outbound message to a carrier — has not been built.
`record-dispute-communication.ts` only ever receives a manually-typed
`body` today; nothing constructs one from this pipeline.

This is deliberate, not an oversight: `GET /api/portal/claims/:id/documents`
(`list-client-claim-documents.ts`) and its portal sibling
(`portal-content-routes.ts`) both deliberately bypass `buildEvidencePacket`
already, and re-justify it in their own header comments — that function's
all-or-nothing `INCOMPLETE_EVIDENCE` throw (any dispute_line missing a
`variance_finding_id` fails the whole packet) is a poor fit for a read-only,
partial-tolerant document list. Those two bypasses stay as they are; this
note is about the pipeline's own missing caller, not about correcting them.

**What unblocks it:** the "compose an evidence-backed dispute communication"
analyst action itself — a route or UI flow that calls
`buildEvidencePacket` for a dispute, `renderEvidenceStatement` per line,
`generateEvidenceProse` over the rendered set, and passes the result to
`recordDisputeCommunication` as the outbound `body`. Until that action is
built, wiring the pipeline into either of the two document-list bypasses
above would be wiring it into the wrong consumer — matching the note this
same file would need to write only when that composition action exists.
