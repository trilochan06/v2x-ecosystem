# Security

## What this project is

A **simulation** of a decentralized V2X architecture, built as an academic
project. It does not run on vehicles, does not talk to real roadside
equipment, and handles no personal data. There is no production deployment to
attack.

## The security in it is modelled, not production-grade

This matters if anyone is tempted to lift code from here:

- **Certificates are HMAC-based**, not IEEE 1609.2 ECDSA. The *sizes* of the
  1609.2 envelope are modelled faithfully (see
  `backend/app/network/messages.py`) because they drive the bandwidth results,
  but the cryptography itself is a stand-in. It is not a PKI.
- **Pseudonym issuance is unlimited per identity.** A real SCMS caps how many
  certificates one enrolled vehicle can hold, which is what makes Sybil
  attacks expensive. This does not, so a coordinated Sybil attack — several
  colluding nodes corroborating each other's fabrications — defeats the trust
  layer here. That is stated on the Security page of the site and in
  `docs/ROADMAP.md` rather than hidden.
- **The radio is a model.** Hop-limited broadcast with a density-dependent
  loss function, not licensed-spectrum C-V2X.

Do not reuse the cryptography for anything real.

## Reporting a vulnerability

If you find a genuine security problem — in the dependency set, in the
container image, or a flaw in how a mechanism is modelled that invalidates a
reported result — open a GitHub issue. Given that nothing here is deployed,
public disclosure is appropriate and there is no embargo period.

## Dependencies

Pinned in `backend/requirements.txt`, `backend/requirements-dev.txt` and
`frontend/package-lock.json`. CI installs from those pins so a build is
reproducible.
