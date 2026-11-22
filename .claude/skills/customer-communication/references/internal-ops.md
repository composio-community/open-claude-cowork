# Internal Operations — NEVER shown to the customer

Everything here is for the agent and the user only. None of these terms, names or systems may appear in
the email, call script or voicemail. If the user asks for a note for the team, write it in the user's
language after the customer block.

**Words that stay out of customer channels:** ClickUp, Zendesk, macro, task, Due Date, INTERNAL_WAITING,
CS_REPLY, LOST LEAD, P+R, resolution field, bonus point, Master Shipping, ShareFile, Nova, staff first names
(Lorenzo, Karla, Aviv, Erika), bundle codes.

## 1. Standing priorities

1. **Ticket subject (Zendesk) is corrected and in CAPITALS**, reflecting case type and invoice. Highest priority.
2. **Shipments already processed are not cancelled.** Document the explanation in both ClickUp and Zendesk.
3. **Offer compensation from the first contact** (high priority).

## 2. General case flow

1. Receive name, phone, email and reason — or, when the app has ClickUp connected, **query ClickUp first** by invoice `#`, customer name or task ID to retrieve the case context automatically (invoice, customer name, purchase amount, salesperson/store, problem/classification, device/product in question, SPARE, assigned agent, due date, dispute status and tracking comments). *(Customer email and phone number are not stored in ClickUp; ask the user or extract from an attached PDF when needed).*
2. Identify the customer by invoice (ClickUp, ShareFile, Nova or Master Shipping); if not found ask for a photo of the ticket or the last 4 digits of the card.
3. Create the ClickUp task (title in CAPITALS: invoice, reason, initial comment) and open the Zendesk ticket.
4. Classify: Defective, Missing Products, GBK, Shalem, Instructions, Refund, Shipping, Regret, Reaction, Restock.
5. First contact: call (voicemail if needed) and send the introduction email.

## 3. Daily follow-up

- After the call and email, change the task Due Date to **tomorrow**; otherwise the task drops off the next
  day's list and is treated as an error.
- Statuses: `CS_REPLY` = waiting for the customer; `INTERNAL_WAITING` = waiting for shipping,
  compensation or accounting.
- Bank gave the customer X days: status Internal Waiting, follow-up date today + X.
- Task state: URGENT when there is no resolution, NORMAL when there is one.
- Priority: HIGH = no resolution / agreeing an offer / new calls and emails; MEDIUM = approvals, refunds,
  tracking numbers; LOW = shipment follow-up, received-confirmation, up-sell follow-up.

## 4. Deadline and closing

- 4+ calendar days without response → deadline macro (Zendesk subject format: `#INVOICE* CITY_STORE* - SMS DEADLINE`),
  only if none was sent before. If a deadline already exists or the status is "deadline", close directly.
- No response: close with resolution **LOST LEAD**. Sample comment: "Closed as LOST LEAD. Deadline sent on [date].
  Customer did not respond after [X] previous contact attempts. If customer re-engages, ticket will be reopened."
- Never leave the resolution field empty.
- Close only after the customer explicitly confirms receipt; record that confirmation as a ClickUp comment first.
  A FedEx signature is not enough.
- Paste the FedEx tracking link into a ClickUp comment whenever a shipment is created.
- Merge Zendesk tickets of the same customer.
- Comments only on important changes, with a photo (delivery, attempt, received).

## 5. Resolutions

- **P+R (Product + Refund):** whenever the agreement includes sending a product *and* a full or partial
  refund, the resolution must be exactly `P+R` (UUID cdc84079-b6a3-4665-9161-97d8d7bac5eb). Not REFUND
  alone, not GIFT alone.
- GBK compensation: use "Instructions" or another real reason, not only "Gift".
- Instructions cases: send the macro and follow up until receipt is confirmed; counts as a bonus point.
- Missing/wrong product reason codes: "Missing Products" or "Wrong Product".
- Compensations are recorded in Master Shippings.

## 6. Refund task (owner: Lorenzo)

1. Check DocuSign: ID belongs to the cardholder. Check: full valid address. Wire: billing address (not the
   bank's), bank can receive international wires without an intermediary (or full intermediary info),
   verify the SWIFT code on the bank's official site.
2. Duplicate the customer-service task, rename `INVOICE + CHECK / WIRE TRANSFER + FULL/PARTIAL REFUND`,
   move it to the REFUND section (List #223500803), set a due date, assign to Lorenzo. Only create it when
   the information is complete.
3. Wire description must be exactly this and nothing else:

```
Name: [customer name]
Email: [email]
Phone: [phone]
Customer Address: [billing address]
Amount: [$ USD]
Bank: [bank name]
Swift : [SWIFT code]
Bank Account: [account number]
```
   For a check, verify name, email, phone, address and amount.
4. Re-check amount, name, account, address and completeness.
5. Send the customer a photo confirmation for checks and wires.

Processing owners and days: checks — Aviv (Wed–Fri) · wires — Lorenzo (every Wednesday, due Tuesday;
reflected instantly to 48 hours) · bank refunds — Erika (almost daily) · check per CS TIPS — Friday/Monday
(due Thursday), reflected in 8–15 days.

## 6b. Payment link and returns

- Shalem payment link requests go to the compensation group in the exact format:
  `Nombre : [name]` / `Direccion: [address]` / `Correo electronico: [email]` / `Numero de telefono: [phone]`.
- Shipping request format: `Invoice - Full Name / Address / Ph / Email / Product / Reason for shipment /
  *Overnight (add *Previous shipping if one was already sent)`.
- Return label request: `Invoice + customer name / Address / Phone / Email / Device name to be replaced /
  "Return Label (RL)" / Reason (for example defective) / *Overnight`. Change the task to INTERNAL/WAITING
  with the comment "Replacement process started" and update it once the label exists. Remind the shipping
  team in the morning.
- Up-seller refunds go through an intermediary (bank + SWIFT).

## 7. Notes on data and ClickUp connection

- **ClickUp live lookup:** Because the host app has a ClickUp integration connected in-process via `mcp__clickup__search_case`, `mcp__clickup__get_task`, and `mcp__clickup__list_tasks` (preconfigured with Customer Service List `48494459`, Refunds List `223500803`, Disputes List `48493938`, and user Donna `101113624`), call `mcp__clickup__search_case` directly (or if deferred, load a single tool via `MCPSearch` with `query: "select:mcp__clickup__search_case"`). Never use `ListMcpResourcesTool` or inspect `~/.claude.json` to test if ClickUp is connected, and never trust prior chat turns claiming ClickUp was disconnected. Always inspect the matching ClickUp task (title, description, custom fields, assignees, due date, and comments) before asking the agent for missing context. Pull: **invoice `#`**, **customer name**, **purchase amount** (`< $500` vs `≥ $500` / `$20K+`), **salesperson / store**, **problem / case reason**, **device or product in question**, **SPARE budget**, and **assigned agent**. Customer **email** and **phone number** are not in ClickUp; ask the user for them (or extract from an attached PDF) when required. Only ask the user for fields that are missing or contradictory in ClickUp.
- `emails.json` (task ID → customer email) is reference data for lookups, not policy; it is not part of this skill.
- Fiscal-address verification exists for SAT compliance, card-fraud prevention (AVS) and correct IVA; ask for
  it when the customer is not in the system or before processing a refund.
