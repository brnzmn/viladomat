# Neutrality policy

This system verifies accounts. It does not investigate people.

## Wording

- Outputs are **discrepancies to verify**. Allowed verbs and nouns: "not reconciled",
  "no supporting document located", "differs from", "outside the expected range",
  "verify whether", "requested on … / not received as of …", "possible link to verify".
- Persons are referred to by **role** (president, administrator, vendor A, owner of unit X),
  never by name, in any output that leaves the review screen.
- Every finding carries its innocent explanations and the document that would resolve it.
- Absence of a hit is stated as **non-exculpatory**; presence of a hit is stated as
  **unverified**.

## Code and repository

- Prompts sent to the extraction model are pure transcription instructions ("transcribe
  verbatim, return null rather than guess, mark handwriting"). They never describe what the
  operator hopes to find.
- Rule names are descriptive of the test ("Payment timing", "Balance continuity"), not of a
  motive.
- Commit messages, docs, issue titles and file names carry no allegations.
- `scripts/neutrality-check.mjs` blocks a vocabulary list in CI. Extend the list; do not
  bypass it.
- Research notes or working hypotheses stay outside the repository.

## Distribution

- Findings reach a counterparty **before** they reach anyone else (right of reply).
- Packs print facts (amounts, dates, pages, articles, requests) and the tier label; internal
  scores and priors stay in the data room with a methodology note.
- Related-party material goes only to the independent reviewer or legal counsel, never to
  the assembly of owners as a whole.
