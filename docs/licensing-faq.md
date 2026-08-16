# Licensing FAQ: is my case a "hosted or managed service"?

**This is not legal advice.** What follows is the licensor's own reading of the
licence the licensor publishes. It is written to help an operator decide what to
do, not to serve as a legal opinion, and it creates no rights or obligations of
its own.

**The licence prevails.** Where anything in this document disagrees with
[LICENSE.md](../LICENSE.md), the text of LICENSE.md governs. This document is an
interpretation of that text; it never overrides it.

**Licensing history lives elsewhere.** For the terms under which earlier versions
of this software were distributed, and for the upstream attribution this software
carries, see [NOTICE](../NOTICE).

---

## The line the licence draws

The Community Edition is distributed under the Elastic License 2.0 (SPDX:
`Elastic-2.0`). That licence lets you use, modify, and redistribute the software,
including for commercial purposes, and places one limitation that matters to
almost every question operators ask. Quoted verbatim from the `Limitations`
section of the licence:

> You may not provide the software to third parties as a hosted or managed
> service, where the service provides users with access to any substantial set of
> the features or functionality of the software.

Three terms in that sentence decide where the line falls:

- **hosted or managed service** — you are running the software so that someone
  else does not have to. The word covers both hosting it on your infrastructure
  and operating someone else's deployment for them as a service you sell.
- **third parties** — people outside your own organisation. Affiliates under
  common control are not third parties for this purpose; customers of your
  business are.
- **substantial set of the features or functionality** — the question is not
  whether you expose the whole product, but whether what you expose is a
  meaningful part of it. Requesting leave, approving leave, and seeing who is
  away already amount to a substantial set.

Everything below applies those three terms to the cases operators actually run
into. Rows 1-4 are your own use; rows 5-8 are service provided to third parties.

| Scenario | Verdict | Why |
|---|---|---|
| Own use — a company deploys the software for its own employees, including in a for-profit business | Permitted, no commercial licence needed | Nobody outside your organisation gets access. Internal commercial use is explicitly allowed by the licence. |
| Own use — a group of companies under common ownership runs one shared instance for all of its entities | Permitted, no commercial licence needed | Entities under common control are not third parties. The instance serves one economic organisation, whatever its legal structure. |
| Own use — contractors, freelancers, and agency staff have accounts alongside employees | Permitted, no commercial licence needed | They are people working for you, recorded like anyone else in your organisation. The licence limits selling access as a service, not who appears on your staff list. |
| Own use — a non-profit, charity, school, or university deploys the software for its own people | Permitted, no commercial licence needed | The licence draws no line between commercial and non-commercial operators. Own use is own use. |
| Service to third parties — an outsourced bookkeeping or payroll bureau keeps its client companies' leave records in the bureau's own instance | Permitted only while the bureau's own staff are the only users; a commercial licence is required the moment client staff get accounts | Back-office work done by your own people inside your own instance is your own use. Once a client's employees or managers sign in to request or approve leave, you are giving third parties access to a substantial set of the functionality. |
| Service to third parties — an integrator installs, configures, and administers the software on the client's own infrastructure | Permitted, no commercial licence needed | The deployment is the client's own copy under the client's own licence. You are selling professional services around software the client runs, not access to software you run. |
| Service to third parties — a managed service provider hosts the software on its own infrastructure and sells client organisations access to it | Not permitted without a commercial licence from the licensor | This is the case the limitation was written for: the software is hosted by you, provided to third parties, and those third parties use its features through your service. |
| Service to third parties — a reseller redistributes a built package to its own customers, in particular under its own brand | Redistribution of the unmodified licensed software is permitted; supplying it under another brand is not, and requires a separate OEM agreement | The licence permits redistribution but forbids altering, removing, or obscuring the licensor's licensing and copyright notices, and any use of the licensor's marks stays subject to applicable law. The right to ship this software under someone else's brand is sold separately as an OEM licence; it is not part of the Community Edition grant. |

## If your case is not in the table

Two cases genuinely sit outside the rows above: mixed arrangements, where part of
your usage is internal and part is sold on, and deployments where it is unclear
who controls the instance. For those, work the three terms in order — who gets
access, are they outside your organisation, and is what they get substantial —
and read the answer off [LICENSE.md](../LICENSE.md), which is what actually
decides the question.

If that still leaves you unsure, or if you want the licensor's position in
writing for your own records, write to **contact@leavepilot.com** with a
description of who runs the instance and who signs in to it. A commercial or OEM
licence covering the cases marked as requiring one is available on request.
