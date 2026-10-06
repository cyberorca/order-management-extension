# CLAUDE.md: Retail Express Order Management Extension

## Project goal
Extend the Retail Express (RE) browser POS with a thin layer that records:
1. **Wearer**: which person each sale line belongs to.
2. **Parent/child links**: which line belongs to which (for example, an alteration belongs to a garment).

RE stays the system of record for products, SKUs, prices, discounts, stock, customers, payments and fulfilment. **Never replace RE and never copy RE data we do not need.** Staff must stay on the RE screen. No second app.

## Architecture (hybrid, thin extension + API-first backend)
```
Chrome/Edge extension (MV3)  -->  Backend API  -->  Database
   reads Order ID + line IDs        auth, save, load     wearers, links (later: status)
   draws buttons/dropdowns          optionally verifies IDs
                                    via official RE REST API
```
- **Extension**: UI and ID reading only. No business logic. Replaceable.
- **Backend**: all logic and the source of truth for our data.
- **Database**: stores only what RE does not.
- Extension storage may cache for speed but is never the source of truth.

## Suggested stack (change only with a reason)
- Extension: TypeScript, Manifest V3, content script + service worker.
- Backend: Node.js (Fastify or Express), TypeScript.
- Database: SQLite for the POC, PostgreSQL for production.
- Tests: Vitest/Jest for backend, Playwright for extension flows.

## Identifiers (key rule)
- Link our data to RE using **`OrderItemId`** (and the RE **Order ID**), never `ProductId` or SKU.
- The same product can appear several times in one order, each with a different `OrderItemId`.
- Brief's findings, **to be verified, not assumed**:
  - Each POS row is a `<tr>` with `data-id` that matches the `OrderItemId` returned by RE.
  - The add-products request carries an `orderId`, and the response lists lines with `OrderItemId`.
  - Fields appear as `data-field="plu"`, `description`, `size`, `colour`.

## Data model (minimum)
```
order_ref      (re_order_id PK, created_at)
wearer         (id PK, re_order_id FK, name, contact_optional)
line_link      (re_order_item_id PK, re_order_id FK, wearer_id FK NULL, parent_item_id NULL)
```
- A line may have no wearer and no parent.
- Parent and child must belong to the same `re_order_id`.
- No cycles in parent links. A child cannot be its own ancestor.
- Do not store price, SKU, stock or payment data.
- Status, measurements, due dates: **future phases only**.

## Phase 0: Discovery (do first, write findings to `docs/discovery.md`)
1. Read the RE developer portal (https://developer.retailexpress.com.au/): REST and legacy SOAP docs for orders, order items, products, customers, authentication, rate limits.
2. Answer: can the API read **live, unsaved** sale lines, or only saved orders?
3. Verify `data-id` equals `OrderItemId` across several real sales, including duplicate products.
4. Record the network calls observed when adding, removing and changing quantity on lines.
5. Write a go/no-go note: what depends on the page structure and what depends on supported APIs.

## Phase 1: Proof of concept (build only this)
1. Detect that the user is on the RE sale screen.
2. Get the current RE Order ID.
3. Find every visible transaction line.
4. Map each line to its `OrderItemId`.
5. Add a small control beside each line.
6. Create or select a wearer.
7. Assign a line to a wearer.
8. Link one line as the child of another.
9. Save through the backend.
10. Close and reopen the sale and **restore the grouped view automatically**.

Out of scope for the POC: login polish, status workflow, measurements, appointments, notifications, supplier orders, reporting, document generation.

## Resilience rules (RE can change its page without notice)
- Put **all selectors in one file** (`selectors.ts`), never inline in code.
- Prefer stable attributes (`data-id`, `data-field`) over class names or position.
- Add a **health check**: on load, verify expected elements exist. If not, show a small visible warning and send a log to the backend. Do not fail silently.
- Never break the RE page. If anything throws, the extension must disable itself quietly and leave RE usable.
- Use a MutationObserver to handle lines added, removed or re-rendered, with debouncing.
- Cross-check line IDs against the API where possible.

## Edge cases to handle or document
Duplicate products, deleted lines (orphaned links), changed quantities, reopened or completed sales, returns and refunds, multiple registers and concurrent users, network failure (queue and retry, show state), partial failures, data sync and recovery.

## Security
- No secrets or API keys in the extension. They live on the backend.
- Authenticate extension-to-backend calls. Use HTTPS only.
- Request the minimum extension permissions, and limit host permissions to the RE domain and our backend.
- Do not log customer personal data.

## Write-back to RE
Default: **no write-back**. Only consider it after Phase 0, only for fields RE officially supports, and only after confirming it is safe. Everything else stays in our database.

## Working rules for Claude Code
- Work in small steps. After each step, summarise what changed and how to test it.
- Before writing code for a new area, state your plan and the assumptions you are making.
- Mark anything unverified as an assumption. Never invent RE API endpoints or fields: check the docs or ask.
- Write tests for backend rules (same-order check, no cycles) and for the selector and health-check logic.
- Keep the repo simple: `/extension`, `/backend`, `/docs`.
- Ask me before adding dependencies, changing the architecture, or expanding scope beyond the current phase.

## Definition of done (POC)
A staff member can open an RE sale, assign lines to wearers, link an alteration to a garment, close the sale, reopen it, and see the same structure restored, without leaving the RE screen or re-entering any RE data.
