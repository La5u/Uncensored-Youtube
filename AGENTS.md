Keep the codebase small and clean: add no more code than needed and remove stale code.

Browser tests stay on the hidden `special:uncensored-smoke` workspace (`--workspace`) with sound
muted. Keep Firefox headless; never fall back to a visible browser on a normal workspace.

Caption acquisition: run manual-auto and synthetic-auto as separate lanes with separate reports.
VPNs run only inside worker network namespaces (at most two tunnels), never system-wide. Don't
interrupt an active acquisition to change its settings. Keep raw captions untouched; run
`npm run corpus:watch` during acquisition (or `corpus:refresh` once). Discovery outputs are leads,
not evidence: validate before changing runtime rules.

Every acquisition/download progress update must include estimated time remaining, based on
recent observed throughput and remaining workload. Give a rough range and label uncertainty;
separate caption and audio estimates when useful. If workload or throughput is unknown, say
so explicitly rather than inventing a precise ETA. File presence alone does not prove complete
windowed audio coverage.

Evidence tiers stay labeled separately and are never relabeled. Synthetic (YouTube's uncensored
automatic track, censored by us on the same timeline) is the primary tier for rules and accuracy;
manual-auto (human captions, often paraphrased or retimed) is secondary. Gates: `docs/RULES.md`. The held-out test set
(`tmp/heldout-*`) is scored only as aggregates; never inspect its captions or errors, or tune on it.
