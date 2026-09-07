# tests/fixtures — captured reality, not invented shapes

**Concern.** Files here are real artifacts taken from the systems they describe, kept so a test can
be anchored on something that actually happened rather than on a shape someone imagined.

The distinction earns its own directory. A fixture invented to match the code under test proves only
that the code matches itself — this repo has paid for that lesson twice, in a mount-narrowing test
whose fixture guessed a slug that never occurs, and in a hallucination-filter test whose cases were
all drawn from the same list the filter reads.

**Surface.**

- `partic_accepted_pipeline.json` — a `partic.pipeline/v1` document that Partic really accepted,
  taken from the authoring repo's history (`pipelines/klaviyo_csv_union.json@12d85366`). It anchors
  `test_partic_document.py`: the validator must pass it untouched, and every rejection test is a
  MUTATION of it, so a rule can only fire for the reason it claims. A validator that rejects what
  the product accepts would block a working pipeline in front of a room — worse than no validator.

**Deps.** None. A fixture is data; the test that reads it names it explicitly.

When adding one, say in its test where it came from and what makes it authoritative. A fixture whose
provenance nobody recorded is an invented shape with extra steps.
