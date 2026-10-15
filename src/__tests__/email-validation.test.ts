import { describe, it, expect } from 'vitest';
import { EMAIL_RE } from '../../plugins/users/services/directory-service';

// Same cases as web-cli and the other servers: the email rule is shared.
const VALID = [
        "a@x.io",
        "root@localhost",
        "first.last+tag@sub.example.co.uk",
        "o'neil@x.com",
        "x@xn--80ak6aa92e.com",
        "a_b-c@my-host.org",
        "ALICE@EXAMPLE.COM",
];
const INVALID = [
        "Nicolae L",
        "nicolae",
        "a@b",
        "a@b.c",
        "a..b@x.io",
        ".a@x.io",
        "a.@x.io",
        "a@-x.io",
        "a@x-.io",
        "a@x_y.io",
        "a b@x.io",
        "a@x.io.",
        "a@@x.io",
        "a@x.123",
        "@x.io",
        "a@.x.io",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@x.io",
        "a@localhost.",
        "a@x..io",
        "",
];

describe('email validation', () => {
    it.each(VALID)('accepts %s', (email) => expect(EMAIL_RE.test(email)).toBe(true));
    it.each(INVALID)('rejects %j', (email) => expect(EMAIL_RE.test(email)).toBe(false));
});
