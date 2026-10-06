# Test coverage map

Every scenario in the `node-vercel-rebuild` delta specs, and every main-spec requirement this change keeps unchanged, mapped to the test that proves it.

| Abbreviation | Test file |
|---|---|
| **R** | `backend/test/repo.test.ts` |
| **A** | `backend/test/app.test.ts` |
| **M** | `backend/test/migrate.test.ts` |
| **C** | `extension/test/content.test.ts` |
| **D** | `extension/test/detect.test.ts` |
| **S** | `extension/test/selectors.test.ts` |
| **Q** | `extension/test/core.test.ts` |
| **E** | `e2e/phase1.spec.ts`, by step name |

Run them with `npm test` (R, A, M, C, D, S, Q) and `npm run e2e` (E).

## staff-auth (new)
| Scenario | Test |
|---|---|
| Successful sign-in | A "returns a token and expiry for correct credentials"; E "sign in through the options page" |
| Wrong password and unknown user look the same | A "wrong password and unknown user look the same" |
| Passwords are not stored readable | A "stores a hash, not the password" |
| Inactive staff cannot sign in | A "inactive staff cannot sign in" |
| Missing token is rejected | A "missing token is rejected with no data" |
| Expired token is rejected | A "expired token is rejected and nothing changes" |
| Tampered token is rejected | A "tampered token is rejected" |
| Health check needs no token | A "health needs no token" |
| Extension package has no secrets | S "contains no secrets" |
| Token cleared when the browser session ends | E "browser restart clears the session token" |
| Expired session prompts sign-in | C "signed out: sign-in prompt"; Q "a 401 clears the token…"; E "signed out: sign-in prompt…" |

## page-resilience (new)
| Scenario | Test |
|---|---|
| Page matches expectations | D "page matches expectations"; C "adds controls and the panel…" |
| Line identifiers missing | D "line identifiers missing…"; C "line ids missing: visible warning…"; E "page not recognised…" |
| Health reports contain no customer data | C "line ids missing…" (no line text in the report); A "rejects oversized or unexpected content" |
| Error while drawing controls | C "fail-safe: an error removes everything and leaves the page usable" |
| Line added | C "a burst of 5 row changes…" (controls on new rows); E "new sale … is its own order" |
| Burst of changes refreshes once | C "a burst of 5 row changes triggers one lookup" |
| Line removed | E "orphaned link: banner, never deleted" |
| Selectors only in `selectors.ts` (design rule) | S "no other source file contains a Retail Express page selector" |

## sidecar-storage (modified and unchanged)
| Scenario | Test |
|---|---|
| Resetting the mock keeps links | A "resetting the mock keeps sidecar links" |
| Separate locations are configurable | M "uses configurable schema names" |
| Write records the staff member | R "records staff…"; A "client cannot claim another identity" |
| Client cannot claim another identity | A "client cannot claim another identity" |
| Unknown staff is rejected | A "deactivated staff is rejected immediately" |
| Write without a session is rejected | A "expired token is rejected…"; A "missing token…" |
| Reassignment is recorded | R "assign, reassign (history only in audit)…" |
| Read audit trail for an order | R "records staff, skips unchanged values, lists oldest first" |
| Unchanged value is not audited | R "records staff, skips unchanged values…" |
| Same name reuses the wearer (unchanged) | R "same name reuses the wearer; other order gets another" |
| Same name on another order (unchanged) | R "same name reuses the wearer; other order gets another" |
| Link read includes wearer identity (unchanged) | R "same name reuses the wearer…" (`wearer` + `wearer_id`) |
| Status removed | A "status routes are gone"; R "stores no RE commercial data and no status" |

## order-line-links (modified and unchanged)
| Scenario | Test |
|---|---|
| Link an alteration to its garment | R "links an alteration to its garment…"; E "8 link the alteration under its garment" |
| Reject a line as its own parent | R "rejects a line as its own parent" |
| Reject a cycle | R "rejects a 2-step cycle" |
| Reject a longer cycle | R "rejects a 3-step cycle" (single write and bulk PUT) |
| Reject a parent from another order | R "rejects a parent from another order" |
| Data footprint check | R "stores no RE commercial data and no status" |
| Assign / reassign a wearer (unchanged) | R "assign, reassign…"; E "6-7 create a wearer and assign a line" |
| Duplicate products receive independent links (unchanged) | R "assign, reassign…, duplicate products independent"; D "duplicate products get distinct ids" |
| Line keeps its links when the order identifier changes (unchanged) | R "line keeps its links when the order identifier changes"; E "complete sale -> reopened by order number…" |
| Reopen restores the grouping (unchanged) | R "links an alteration…; reopen restores structure"; E "9-10 persisted; close and reopen…" |
| Reopen under a new identifier (unchanged) | R "lookup finds the order without registering the identifier"; E "complete sale -> reopened by order number…" |
| Unknown order returns an empty structure (unchanged) | R "unknown order returns an empty structure"; R "never-stored lines create nothing" |
| Deleted line's link survives (unchanged) | R "orphaned links are flagged, never deleted"; E "orphaned link…" |
| Stale update is rejected (unchanged) | R "stale version is rejected and nothing lands"; A "maps errors…"; E "409: …conflict shown" |

## order-identity (unchanged; migration removed)
| Scenario | Test |
|---|---|
| Two identifiers resolve to one order | R "two identifiers resolve to one order" |
| Wearer reuse spans aliases | R "wearer reuse spans aliases" |
| Lines find their order without registering the identifier | R "lookup finds the order without registering the identifier" |
| New sale next to stale lines is not merged | R "new sale next to stale lines is not merged"; E "new sale next to the previous order's lines is its own order" |
| Lines that were never stored | R "never-stored lines create nothing" |
| Lines from two different stored orders | R "lines from two orders are not merged; majority wins"; R "tie goes to the oldest order" |
| Write under a new identifier joins the existing order | R "write under a new identifier joins the existing order" |
| New line on a reopened order joins it | R "new line on a reopened order joins it"; R "alteration link joins its garment's order" |

## order-guards (modified and unchanged)
| Scenario | Test |
|---|---|
| Structure change rejected after completion | R "rejects wearer, parent and note changes without override"; E "completed order: lock banner…" |
| Override is applied and audited | R "applies and audits an override"; C "locked: … resends with override"; E "override applied and audited" |
| Link read reports completion | R "rejects wearer… without override" (`completed`); R "complete is idempotent…"; E "complete sale…" |
| Sidecar goes down | Q "sidecar goes down: edit queued with count, not saved"; C "queued edits: shows the waiting count…"; E "backend down: edit queued with count…" |
| Queue replays when back online | Q "replays in order when back online, chaining own versions"; Q "queue survives a service-worker restart" |
| Replay stops at a conflict | Q "replay stops at a conflict for that order; other orders continue"; C "replay conflict…"; E "replay stops at a conflict; the other change is kept" |
| Recovery via Retry | Q "recovery via Retry flushes immediately"; E "backend down: … Retry replays it" |
| Add / clear / reject oversized note (unchanged) | R "adds, clears (old value audited) and rejects oversized"; E "note on a line" |
| Warning on quantity 2 (unchanged) | C "quantity 2 warns before assigning…"; C "warns using the quantity shown at click time"; E "quantity 2 warns…" |
| No warning on quantity 1 (unchanged) | C "quantity 2 warns…; quantity 1 does not"; E "6-7 …" (only a prompt, no confirm) |
