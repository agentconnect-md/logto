---
"@logto/core": patch
"@logto/connector-kit": patch
"@logto/connector-azuread": patch
---

fix Microsoft guest identity verification across tenants

Microsoft sign-in supports encrypted token storage. Management API machine-to-machine clients can verify a linked account's identity in another tenant without receiving its credentials or changing the account link.
