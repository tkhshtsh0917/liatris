# Using search interaction logs

[日本語](ja/log-analysis.md)

Collection consent in Liatris is the host's explicit permission to start measurement. The collector stays disabled until the host grants it and stops local collection on withdrawal. Define the allowed destination, fields, retention and purposes in the host integration. Review secondary use for training separately, including access, redaction and deletion. [Security and privacy](security.md)

## Query-level ranking and retrieval

| Use | Data and first validation |
| --- | --- |
| Diagnose and evaluate search | Link query, result set, displayed rank, exposure, click and confirmed outcome. Include zero results, no-click displays and aborted observations as distinct cases. Track denominators, coverage and ranking version. |
| Learn from biased feedback | Retain the displayed slate, candidate and result IDs, layout, ranker version, experiment assignment and the logging policy's assignment probability if randomized. Estimate examination propensity with a justified model or controlled swaps. Compare IPS with a relevance-judgment baseline and monitor support, weight variance and sample size. Presentation rank alone leaves examination probability unidentified. |
| Train a dense retriever | Join an item-specific confirmed conversion to a query through its prior impression or click using a declared attribution window. Use the pair as a high-confidence example and retain separate click-only signals. Limit hard negatives to plausible candidates and filter known positives and ambiguous duplicates. Split by time and session, prevent post-query feature leakage, and validate on held-out judgments and an online experiment. Raw query text requires an approved source and preprocessing. |

A request-level ID gives events a stable join key. The host must still define outcome semantics and attribution, especially when a session has multiple queries or generates multiple item conversions. Purchase probability can reflect price, availability and exposure as well as relevance. [Unbiased Learning-to-Rank](https://arxiv.org/abs/1608.04468) · [Dense retrieval with hard negatives](https://arxiv.org/abs/2007.00808)

## Optimize the search journey

1. Build short-lived sequences of queries, filters, displayed slates, clicks and confirmed outcomes. Use the session as a boundary and identify task switches where possible. At serving time, use only the prefix available before the decision.
2. Start with a non-personalized ranker as the baseline. Compare reranking that avoids repeated ineffective results, lifts previously productive categories or filters, and responds to reformulations. Related actions include suggesting a refined query or preserving useful constraints after a zero-result search.
3. Evaluate a fixed session or task horizon. Track successful journeys, time and steps to the first success, and zero-result recovery. Keep per-query relevance, coverage, latency and segment checks as guardrails. Leave sessions with unknown outcomes marked as such.
4. Have the host experimentation system randomize at the unit appropriate to the service. Record the variant applied to the rendered event. Keep treatment stable for that unit and compare by original assignment. Evaluate policy support and action probabilities before counterfactual session-policy evaluation.

Use session-aware evaluation first, then compare context-aware policies in controlled experiments. The same sequence can contain an exploration, a second task or an exit after finding a sufficient answer. Treat short paths and fewer queries as supporting measurements. [Session rank-biased precision](https://discovery.ucl.ac.uk/id/eprint/10081529/) · [Session-based query suggestion](https://research.google/pubs/learning-to-attend-copy-and-generate-for-session-based-query-suggestion/)
