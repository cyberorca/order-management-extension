# Phase 0 Discovery

Status: **partial**. Points 1 and 5 are based on public sources. Points 2–4 are blocked until we have access to a Retail Express test tenant (brief §13).

Rules for this document:
- Every Retail Express endpoint or field named here has a citation.
- Anything not cited is marked **unknown**.
- Nothing is inferred from the mock POS.

Sources read on 2026-10-06:
- [S1] https://developer.retailexpress.com.au/ (portal landing page)
- [S2] https://developer.retailexpress.com.au/retail-express-api (REST API overview)
- [S3] https://developer.retailexpress.com.au/legacy-soap-api (legacy SOAP overview)
- [S4] `retail-express-extensions/Retail Express - V2 Web Store API.pdf`. The method names below come from the earlier Python POC, which read this PDF to build its SOAP mock. This session could not render the PDF (no PDF tools installed), so treat S4 items as **to re-verify**.
- [B] `retail-express-extensions/Retail_Express_Order_Management_Developer_Brief.pdf`: the client's own DevTools findings (§4).

The REST specification page linked from [S2] (`/apis/5aee6e1e-…`) returned **HTTP 404** to an unauthenticated fetch. It probably needs a developer-portal login. Field-level REST details are therefore **unknown**.

## 1. Public API surface

### REST API (recommended for new work) [S1, S2]
- "Modern REST API … the focus for all new development and the recommended starting point for new integrations" [S1].
- Base URL `https://api.retailexpress.com.au/`. Other hosts in examples "will soon be retired", effective September 2026 [S2].
- Versions: V2 (February 2021) and V2.1 (April 2023, recommended). Path shape is `/{version}/{endpoint}` [S2].
- **Authentication** [S2]:
  - Send `x-api-key` to `POST https://api.retailexpress.com.au/v2.1/auth/token` to get a bearer token.
  - Then send `x-api-key` plus `Authorization: Bearer <token>` on every call.
  - Tokens expire after 60 minutes. A 401 means invalid or expired.
  - **Consequence for us:** the RE API key is a secret, so it lives on our backend only, never in the extension (CLAUDE.md security rule).
- **Rate limits** [S2]: 300 requests per minute (about 5 per second) and 100,000 per 24 hours, with `429 Too Many Requests` when exceeded. "Rate limits may change at any time."
- **Resources named in the docs** [S2]: `/v2.1/customers`, `/v2.1/customers/{id}`, `/v2.1/orders`, `/v2.1/orders/{id}`, `/v2.1/products`, `/v2.1/products/{id}`, `/v2.1/outlets`, `/v2.1/outlets/{id}`, `/v2.1/auth/token`.
- **Unknown** (needs the spec page): whether `/v2.1/orders/{id}` returns line items, and under which field names (in particular whether an `OrderItemId`-equivalent is exposed); which order states are listed (open, parked, layby, in-progress); filters; write operations.

### Legacy SOAP services [S1, S3, S4]
- Described as giving access to "data and functionality not yet available in the Retail Express API" [S1].
- Services listed: Warehouse Management, Webstore, Accounting, Inventory Planning, plus Integrated Gift Vouchers and EDS API [S3].
- They exchange XML. They're "designed around the premise that an external system can pull down all the information needed … to have a copy of all relevant data in its own database". Some bulk operations return Base64 GZIP [S3].
- Web Store API methods (to re-verify) [S4]: `OrderCreateByChannel`, `OrderAddPayment`, `OrderCancel`, `OrdersGetHistoryByChannel`, `CustomerGetDetails`. Calls use a SOAP `ClientHeader` (ClientID, UserName, Password). Per the earlier POC, `OrdersGetHistoryByChannel` returns `OrderDetail` rows carrying `OrderItemId`.

## 2. Can an API read live, unsaved sale lines?
**Blocked: needs tenant.** Nothing public says that any API exposes a sale while it's still being rung up. The brief [B §4.2] shows the browser session holding an `orderId` (a GUID) during the sale. That's evidence of internal POS endpoints, not a supported API.

Check to run with tenant access:
1. Start a sale and add 2 lines. Copy the `orderId` from the add-products XHR.
2. Call `GET /v2.1/orders/{that id}` (and try a list with recent filters). Record whether the open sale is returned, and with which line fields.
3. Complete the sale and repeat. Record whether the ID changes (GUID vs order number) and whether the line IDs stay the same.

## 3. Does `data-id` equal `OrderItemId` across real sales, including duplicates?
**Blocked: needs tenant.** The client observed this on one sale [B §4.1, §4.3, §4.4]. It hasn't been checked across several sales.

Check to run: for 5 sales, at least 2 of them with the same product on two lines, record every row's `data-id` and compare it with the `OrderItemId` in the add-products response. Also compare it with the API's line identifier (point 2), once known.

## 4. Network calls when adding, removing and changing quantity
**Blocked: needs tenant.** Known so far: the add-products request carries `items[].ProductId`, `Quantity` and `orderId`, and its response lists lines with `OrderItemId`, `ProductId`, `SKU`, `Code`, `Description`, `Size`, `Colour`, `Quantity`, `UnitPrice`, plus stock, tax, outlet, fulfilment and discount fields [B §4.2–4.3].

Check to run: in DevTools → Network → Fetch/XHR, record the URL, method, request and response (with personal data redacted) for each of:
- add a line
- add the same product again
- remove a line
- change a quantity
- park and resume
- complete
- reopen
- return or refund

Note which of these change an `OrderItemId`.

## 5. Go / no-go note

| Part | Depends on | Risk | Status |
|---|---|---|---|
| Detect the sale screen and order ID | Page structure: `data-order-id`-like attribute or URL; XHR `orderId` [B §4.2] | Medium. Undocumented, but there are three detection layers | Built against the mock; real selectors are Phase 0 |
| Line → `OrderItemId` | Page `tr[data-id]` [B §4.1]; XHR `OrderItemId` [B §4.3] | Medium. The core assumption | **Verify (point 3)** |
| Lines survive completion and reopen | `OrderItemId` staying the same | **High.** If line IDs change, links are lost | **Verify (point 2)**. The design already tolerates order-ID changes |
| Show extra structure, save links | Our backend only | Low | Built |
| Cross-check line IDs against the API | REST orders resource (fields unknown) or SOAP `OrdersGetHistoryByChannel` [S4] | Low; optional | Needs the spec and an API key |
| Completed-order signal | Page or XHR, unknown | Medium | Mock uses `data-order-status`; real signal is Phase 0 |
| Write-back to RE | Not planned (CLAUDE.md) | n/a | No |

**Recommendation: GO for continuing on the mock, NO-GO for production** until checks 2 and 3 pass on a tenant. The design depends on just one unverified fact: `OrderItemId` is stable and matches the row's `data-id`. If that holds, everything else is already handled, including an order ID that changes. If it fails, the fallback is matching lines through the API after completion (point 2), which needs the REST spec.
