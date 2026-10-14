# Hermes assignment — C1: authenticated SePay normalization

Start only when explicitly dispatched after B2 acceptance. Read AGENTS.md,
the shared security spec, and Packet C Task 1. Implement only that task, using
its exact file allowlist. Preserve all existing changes on dev. No commit,
push, deployment, remote DB access or live webhook/bank requests.

Use official SePay documentation to verify webhook and API v1/v2 field aliases;
include source URLs and mapping in the report. Pure normalization must preserve
numeric/string/UUID IDs and enforce exact normalized account, incoming direction,
strict date parsing with the existing timezone semantics, and bounded canonical
BigInt amounts. Reject unsafe JS numbers. Missing webhook key must return 503 in
all environments; authenticate before business parsing. Valid unrelated/outgoing
transactions return ignored=true with no business writes. Malformed data is 400.
Missing configured account is 503. Do not weaken the existing 60-second tolerance.

Official source entry points located by coordinator (read their full relevant
field tables before implementing):
- https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook
- https://docs.sepay.vn/api-giao-dich.html
- https://developer.sepay.vn/vi/sepay-api/v2/giao-dich/danh-sach

The v1 docs show money strings with `.00`; explicitly normalize documented
integer-valued decimal representations to canonical integer strings before the
strict core parser, while rejecting nonzero fractional VND and unsafe numbers.

Run real failing-before tests, implement, then run all SePay unit/controller/API
client tests plus API typecheck and related Telegram lookup regressions. If older
tests require contract updates outside the allowlist, request specific files.
Coordinator owns app/env/manifests/contracts. Report exact shared patches instead
of editing those. No C2 or other packet until coordinator acceptance.
