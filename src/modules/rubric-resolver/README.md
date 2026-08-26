# rubric-resolver module

The database-backed resolver starts with `selectRubricVersion`, a versioned
bitemporal selector. Given a known rubric, business-effective date, and
system-time cutoff, it returns the single append-only version that was both
effective and known, or an explicit `NO_VERSION_KNOWN` result.
