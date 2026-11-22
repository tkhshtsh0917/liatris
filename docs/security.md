# Security and privacy

[日本語](ja/security.md)

## Browser data and consent

The HTTP sender uses `credentials: "omit"` and `referrerPolicy: "no-referrer"` and rejects redirects. Relative collection paths resolve against the page origin. Collection requires HTTPS. Anonymous same-origin loopback is available for local development. Browsers may still send an Origin header, and the infrastructure can see connection information such as IP addresses. [Fetch Standard](https://fetch.spec.whatwg.org/)

The collector starts with collection disabled. The host supplies the consent state. Queued delivery shares revocation across same-origin tabs in the collection scope. Collection creates no Liatris cookie or cross-session visitor ID. Use the in-memory session store for tab-only tracking. The IndexedDB store shares an opaque, scoped session ID among same-origin tabs and across reloads. Its persisted state is cleared on explicit revocation, or rotated on the next eligible activity after expiry. Expiry alone does not schedule background deletion. A scoped session ID and search metadata can still be linkable data. [W3C Privacy Principles](https://www.w3.org/TR/privacy-principles/)

Keep query text disabled unless there is a specific approved purpose. Use a declared event with an opaque query ID and count metadata for search measurements that do not need text. Keep form values, account and device IDs, full URLs, and credentials out of custom fields. Apply server-side data validation and minimization even when the host already does it. Configure separate retention periods for raw events, security logs, and aggregates. Review deletion across sinks, backups and queued data. The demo prints only accepted record categories. [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

## Authenticate each intake

Prefer a first-party collection endpoint. For authenticated delivery the host provides a short-lived, write-only bearer credential at send time. Keep it in memory. Configure the verifier to trust a specific issuer or credential store. The verifier must authenticate the token before returning claims. For a signed token, use an established JOSE library, restrict algorithms and trusted keys, and handle key rotation and claim validation. An opaque token can be verified against a trusted credential store. [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html) · [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html) · [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)

The receiver checks audience, expiration, `liatris:write`, tenant and application before reading and validating the bounded body. It uses its server-side profile mapping for routing and the profile hash for compatibility. CORS and Origin checks limit browser access. Keep them separate from token authentication. An anonymous token issuance endpoint also needs quotas and abuse controls. Keep sensitive conversions such as completed purchases backed by trusted server events. [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/)

For an external endpoint, allow only the exact approved origins in CORS and `connect-src`. Where needed, permit the `Authorization` and `Content-Type` headers in the preflight response. Keep long-lived secrets, signing keys, and downstream credentials on the server. Give the Kinesis bridge an IAM role scoped to writing to the intended stream. Authenticate native gRPC forwarding with the service's workload identity. [Content Security Policy](https://www.w3.org/TR/CSP3/) · [Kinesis IAM documentation](https://docs.aws.amazon.com/streams/latest/dev/controlling-access.html)

## Production readiness

The reference receiver accepts one uncompressed JSON record up to 32 KiB. The body read defaults to a 10-second deadline following authorization. The reference demo uses SQLite durable acknowledgements and deduplicates by scope and event ID. Its security headers and socket restrictions serve its local browser page. Before external deployment, establish header and total timeouts, authorization capacity and deadlines, pre-auth and per-tenant quotas, replay and idempotency controls, durable acknowledgements, and audit-log redaction at the gateway and sinks.

Verify that revocation aborts active requests and prevents queued sends, including across tabs. Test that the credential used for a retry matches the same tenant and application. Validate retention and deletion against the actual storage setup. Verify release checksums and dependency and runtime security updates. The [roadmap](roadmap.md) tracks these release conditions. [NIST Secure Software Development Framework](https://csrc.nist.gov/pubs/sp/800/218/final)
