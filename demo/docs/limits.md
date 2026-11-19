---
title: Limits
order: 2
---
# Limits

The demo allows 1000 requests per day and 60 per minute for each account, whatever the number of its tokens.
Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; over a limit the
answer is `429` with `Retry-After`.
