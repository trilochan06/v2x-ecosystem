# Contributing

## Setup

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt

# Frontend
cd ../frontend && npm install
```

## The gates

CI runs exactly these, and a change is not done until they pass locally.

| | Backend | Frontend |
| --- | --- | --- |
| Lint | `ruff check .` | `npm run lint` |
| Types | `mypy` | `npm run typecheck` |
| Tests | `pytest --cov` | `npm test` |
| Build | — | `npm run build` |

`pytest --cov` enforces a coverage floor (see `backend/pyproject.toml`). The
floor exists to catch a change that deletes tests, not to chase 100%.

## The thing most likely to trip you up

**There are two engines, and they have to agree.** `backend/app/` is the
reference implementation and the source of the report's numbers.
`frontend/src/sim/` is a TypeScript port of it, and that is what the hosted
site actually runs.

Any change to simulation behaviour has to land in both. In particular the
frame-size constants in `backend/app/network/messages.py` and
`frontend/src/sim/core.ts` are pinned to identical values by
`backend/tests/test_messages.py` and `frontend/src/sim/sim.test.ts` — if you
change one side only, one of those two suites fails, which is the point.

The congestion model is the exception: it is not reimplemented. The
TypeScript walks the gradient-boosted trees exported from the fitted
scikit-learn model in `frontend/src/sim/model.json`, and reproduces
scikit-learn's prediction to within 5e-07.

The two engines use different random number generators, so a given seed does
**not** produce identical runs. Compare them distributionally, over several
seeds, never per-seed.

## Reporting results

Anything quoted as a result needs more than one seed. The harness runs N
seeds per configuration and reports a mean with a 95% confidence interval
(Student's t — see `backend/app/stats.py` for why not 1.96 sigma). If two
intervals overlap, say they overlap; don't report the difference between the
means as though it were established.

## Style

Ruff and ESLint settle formatting arguments. Beyond that: comments should
explain *why* a thing is the way it is — a constant traceable to a standard,
a trade-off that was considered, a bug a check exists to prevent. Comments
that restate the code get deleted in review.
