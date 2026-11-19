---
title: Authentication
order: 1
---
# Authentication

Public API routes accept only `host` tokens (`qcli_pat_…`). A host application creates them for its users,
for example on an account page:

```typescript
const { token } = await usersPlugin.apiTokens.create(userId, {
    name: 'my app',
    audience: 'host',
    permissions: ['demo:read'],
});
```

Send the token as `Authorization: Bearer <token>`. Tokens of the CLI (`cli` audience) and sign-in sessions
are refused with `403 forbidden: a host token is required`.
