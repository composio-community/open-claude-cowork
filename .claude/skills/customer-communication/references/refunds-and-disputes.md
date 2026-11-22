# Refunds, Disputes and Payments

Customer-facing rules for refund messages. Task-system steps live in `internal-ops.md`.
A *refund approved* is good news and can be written; a *refund not available or not yet decided* follows
the bad-news rule (deliver it live on the call).

## 1. Decision path

1. **Open dispute with the bank?** The refund cannot proceed. The customer must cancel the dispute and
   provide the bank's closure letter. Any earlier offers (refund or gifts) are withdrawn once a dispute is
   opened; if the bank closes it in our favour, a replacement can still be sent but a refund cannot.
2. **Compensation offered and rejected, purchase under $500 USD, no dispute → refund approved.**
3. **$500 USD or more → escalate**; promise nothing until it is approved.
4. Ordinary cases only; the "no refund" categories in `business-rules.md` §4 still escalate (PENDING #1).

## 2. Method by country

| Country | Method |
|---|---|
| Canada | Wire transfer (preferred), or Interac e-Transfer if the customer asks for it |
| USA | Physical check |
| Mexico | Wire transfer or check |

## 3. What the customer must do

**Always, in writing (email is fine):**
1. Confirm they have not opened, and will not open, a dispute with their bank.
2. Accept the refund as the final resolution of the case.

**Wire transfer or check:** complete a DocuSign.
- Wire: name matches the original cardholder; billing address (not the bank's address); bank name, account
  number, SWIFT code, ABA/routing where it applies; intermediary bank details if their bank uses one. The bank
  must be able to receive an international wire.
- Check: full, valid mailing address.

**e-Transfer:** only the email linked to their bank account.

**Signing the DocuSign (phone or computer):**
1. Click "Review Document", then "Continue".
2. Click the "Sign" icon and draw or choose a signature style (it must match the ID).
3. Attach a photo of a government-issued ID that matches the cardholder.
4. Click "Finish"; the document goes to our office automatically.

If the ID photo is invalid (for example a photo of something else), explain why and send a new DocuSign.

**Why we ask for the billing address:** Mexican tax compliance, fraud prevention (card address verification)
and correct tax calculation. Say this when a customer asks why.

## 4. Timing to tell the customer (typical, never a guarantee)

- Wire: processed once a week; usually reflected within 48 hours after processing.
- Check: mailed with a photo of the check and tracking; typically 8–15 days in transit. We follow up until they confirm receipt.
- Billpocket sales: refund possible for sales up to 30 days old; Santander sales up to 3 months. Refund goes
  back to the original payment method and needs the same written confirmations.

Send a confirmation with a photo when a check or wire has been issued.

## 5. Explaining a dispute (chargeback)

A dispute happens when a cardholder asks their bank to reverse a payment. The bank temporarily removes the
funds and opens an investigation that can take up to three months. Use it as information, not as a threat.

Sample wording:
> Please do not initiate a dispute (chargeback) with your bank. A dispute freezes the funds and delays your
> refund. If you have already contacted your bank, please let us know so we can guide you.

Use the fuller explanation of consequences only when the customer refuses to work with us.

## 6. Payments the customer sends us (Shalem plan)

- Lost card or missing payment: offer a payment link, or a wire for the full balance (the finance fee is
  discounted when they pay in full).
- To request a payment link, collect exactly these four data points from the customer: full name, full
  address, email, phone number.
- Checks payable to **Morena Mia USA Inc**, mailed to **4023 Kennett Pike #50434, Wilmington, DE 19807**.
- **STRICT LEGAL GUARDRAIL — Never claim or promise contract modification:** It is strictly prohibited to tell a customer that their contract was modified, that the name on their Shalem (or purchase) contract has been corrected, or that the contract name will be updated once they confirm their details. Making such claims is dangerous and creates legal liability; neither Claude nor the skill may make that decision. **If and only if** the agent explicitly states it in their prompt **or** the ClickUp comments explicitly state that the contract name was or will be updated, may you mention or argue that the name on the contract was changed or will be changed. Otherwise, request or confirm the 4 data points solely to process the payment link or reactivation.

## 7. Wording guardrails

- Never write "refund" before the ladder in §1 says it applies.
- Never state a processing date you do not control; use "typically".
- Never name staff, task systems or internal labels (see `internal-ops.md`).
- Never state or imply that a contract (or the name on a contract) was modified or will be updated upon customer confirmation unless the agent or ClickUp comments explicitly say so (`SKILL.md` §0.16).
