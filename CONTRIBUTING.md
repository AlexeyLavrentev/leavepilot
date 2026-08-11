# Contributing to LeavePilot Community

This file states the terms on which a contribution to this project is accepted.
Two conditions apply to every contribution, and both are set out below — the
grant of rights first, so that you read what you are agreeing to before you read
how that agreement is expressed.

Nothing else lives here. The development process, test requirements, and issue
and pull request templates are deliberately outside the scope of this document.

## Grant of rights

By submitting a contribution to this project — as a pull request, as a patch, or
in any other form — you grant Alexey Lavrentev, the licensor named in
`LICENSE.md` and `NOTICE`, a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable licence to reproduce, modify, prepare derivative works of, publicly
display, publicly perform, sublicense and distribute your contribution and any
derivative works of it **under any licensing terms, including proprietary and
closed-source terms**.

This expressly includes, and is not limited to:

- distribution of your contribution as part of the community edition under the
  Elastic License 2.0, whose text is in `LICENSE.md`;
- distribution as part of the closed-source LeavePilot Premium module, which is
  sold commercially and is not published under the Elastic License 2.0;
- distribution as part of OEM or white-label deliveries, in which the software
  is supplied under a customer's own brand on separately negotiated terms.

You retain copyright in your contribution. This is a licence granted to the
licensor, not an assignment: it does not take your copyright away from you, and
it does not restrict what you may do with your own work anywhere else.

You also confirm that the contribution is yours to give — that you hold the
rights you are granting here, and that no employer, client or earlier licence
stands in the way of granting them.

The grant is deliberately broad, and the reason is stated here rather than left
to be discovered: a contribution that cannot be relicensed cannot be taken into
the premium module or into an OEM delivery at all, so a narrower grant would
mean refusing contributions rather than accepting them on softer terms. The
known cost of asking for this is that some contributors will not accept the
clause and will not contribute. That is a trade-off this project has accepted
with its eyes open, not an oversight. If it is a clause you cannot accept,
please open an issue and say so, rather than sending a pull request under terms
you did not mean to agree to.

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by` trailer. Add it with the `-s` flag:

    git commit -s -m "your message"

which appends a line of this form to the commit message:

    Signed-off-by: Your Name <you@example.com>

The trailer certifies that you wrote the contribution yourself, or that you
otherwise have the right to submit it under the terms set out above. It is the
Developer Certificate of Origin, version 1.1 (https://developercertificate.org/),
reproduced in full at the end of this document.

CI rejects any pull request that contains a commit without a `Signed-off-by`
trailer. The check covers the commits of the pull request itself, not the
history of the repository, and merge commits are skipped. If you have already
made commits without the trailer, sign them where they are:

    git rebase --signoff <base>

where `<base>` is the revision your branch started from. The failing CI step
prints the exact revision to use, so you do not have to work it out.

One reading note on the text below. The Developer Certificate of Origin is
reproduced verbatim, as its own terms require, and its clause (a) speaks of "the
open source license indicated in the file". This software is source-available
rather than open source: read that phrase as the terms stated in `LICENSE.md`
and in the grant above. The certificate is not edited to say so, because an
edited certificate is no longer the certificate that everyone else has read.

## Developer Certificate of Origin 1.1

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
