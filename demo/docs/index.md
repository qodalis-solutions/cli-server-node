---
title: Welcome to {{name}}
order: 0
---
# Welcome

This demo server publishes a small public API next to its CLI. Every request needs an API token of the
`host` audience, sent as `Authorization: Bearer <token>`.

```bash
curl -H "Authorization: Bearer $TOKEN" {{baseUrl}}/v1/demo/time
```

See [Authentication](guides/authentication) for getting a token and [the API reference](reference) for every route.
