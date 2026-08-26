# rate-engine module

`generate-expected-charges.ts` creates canonical expected-side financial
evidence. `align-tier1-charges.ts` performs only deterministic one-to-one
category/currency alignment; missing and many-to-one candidates are explicit
unassessable issues for higher tiers rather than guessed by input order.
