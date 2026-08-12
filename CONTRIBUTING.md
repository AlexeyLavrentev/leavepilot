# Contributing to LeavePilot Community

This file states the terms on which a contribution to this project is accepted.
Two mechanisms apply to every contribution: the Contributor Licence Agreement
(the legal grant, in `docs/CLA-individual.md` and `docs/CLA-corporate.md`) and
the `Signed-off-by` trailer (a technical CI gate that certifies provenance).
The CLA is the source of the grant; the sign-off is its CI enforcement
companion, and both are set out below.

Nothing else lives here. The development process, test requirements, and issue
and pull request templates are deliberately outside the scope of this document.

## Contributor Licence Agreement

Every contribution is made under a Contributor Licence Agreement. The full grant
lives in the agreement itself, not in this file: the agreement is the single
source, and restating the grant here would be a drift surface this project has
deliberately rejected.

- **If you are contributing as yourself**, read and sign
  [`docs/CLA-individual.md`](docs/CLA-individual.md) (the Individual Contributor
  Licence Agreement).
- **If you are contributing in the course of employment**, your employer signs
  [`docs/CLA-corporate.md`](docs/CLA-corporate.md) (the Corporate Contributor
  Licence Agreement) through its authorised signatory, and you must be listed on
  its Schedule B before your contribution is merged.

In short, and non-bindingly: you grant the Licensor a perpetual, irrevocable,
worldwide, royalty-free licence to use your contribution under any terms,
including proprietary terms for the Premium and OEM deliveries, and you keep
your copyright. If this summary and the agreement in `docs/CLA-individual.md`
or `docs/CLA-corporate.md` ever differ, the agreement file is the grant and this
summary is not.

When you open your first pull request, CLA-Assistant asks you to sign through
GitHub. It links the agreement that matches your path — individual or corporate
— records your acceptance against your GitHub account, and sets the status check
to passing. Once signed, the check stays green for your subsequent pull requests
until the agreement text changes, at which point you are asked to sign again.

## Developer Certificate of Origin

Every commit must carry a `Signed-off-by` trailer. Add it with the `-s` flag:

    git commit -s -m "your message"

which appends a line of this form to the commit message:

    Signed-off-by: Your Name <you@example.com>

The trailer certifies that you wrote the contribution yourself, or that you
otherwise have the right to submit it under the Contributor Licence Agreement
above and in `docs/CLA-individual.md` / `docs/CLA-corporate.md`. It is the
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
and in the Contributor Licence Agreement above. The certificate is not edited to
say so, because an edited certificate is no longer the certificate that everyone
else has read.

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
