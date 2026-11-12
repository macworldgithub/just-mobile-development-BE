# JustMobile — Remaining Tasks & Handover Document

**Last Updated:** 11 November 2026  
**Repositories:**
- Frontend: `just-mobile-development-FE` (`main` branch)
- Backend: `just-mobile-development-BE` (`main` branch)

---

## 1. Executive Summary & Progress Checkpoint

All core carrier operations (19 native Octane SOAP/REST endpoints), ACMA TCP C628 pre-port 2FA, GSMA LPA digital eSIM generation, automated welcome email delivery via Hostinger SMTP, ATO-compliant tax invoices, and the official 8-tier carrier rate card from `bele-app.plans.json` ($20.54 to $67.00 with Zero Bill Shock) are **100% complete, verified, and pushed to `main`**.

Handsets have been simplified from complex 12/24/36-month debt bundles into a **clean, transparent outright e-commerce experience** per the client's explicit instructions:
> *"Just regular ecommerce experience... For the plans make it like Octane that’s fine. Don’t worry about the phone packages just make it simple ecom for now."*

All artificial 500GB rollover/data banking claims have been completely removed across the frontend, backend, prompts, and database.

---

## 2. Master Remaining Task Matrix (~2 to 2.5 Days Total)

| # | Task | Category | Estimate | Status | Action Owner |
| :-: | :--- | :---: | :-: | :---: | :--- |
| **1** | **Handset Fulfilment & Dispatch Emails** | E-Commerce / Email | **0.5 day** (3–4 hrs) | ⏸️ **On Hold per Client** | Engineering |
| **2** | **Admin Portal: Device Orders & Tracking** | Admin Operations | **0.5 day** (3–4 hrs) | ⏸️ **On Hold per Client** | Engineering |
| **3** | **Port-In Donor Rejection Error Alerts** | Telco UX / Error Flow | **0.25 day** (1–2 hrs) | ✅ **Completed & Verified** | Engineering |
| **4** | **Westpac QuickStream Payment Gateway** | Payments & Auto-Pay | **0.5–1.0 day** | 🟡 **Documented; Awaiting Client Confirmation** | Engineering / Client |
| **5** | **Live Wholesale SIM Test (`TELCO_LIVE_CREATE`)** | Carrier Activation | **0.5 day** | ✅ **Completed & Verified** (`custNo: 551059`) | Engineering |

*(Note: Production Cloud Hosting & Domain DNS has been removed from this scope per user instruction).*

---

## 3. Detailed Specification of Remaining Tasks

### Task 1: Handset Fulfilment & Dispatch Emails (0.5 Day) — 🟢 Unblocked
* **Objective:** Wire Hostinger SMTP to handle the physical e-commerce phone order loop.
* **Requirements:**
  1. **Warehouse Notification Email:** When a customer orders a handset outright, trigger an email to `orders@justmobile.com.au` (or support team) containing:
     - Customer Name, Telco Customer # (`custNo`), Phone, Email
     - Delivery Shipping Address (Street, Suburb, State, Postcode)
     - Handset Model, Storage (e.g. 512GB), Colour, and Outright Price ($AUD)
     - Order Reference ID
  2. **Customer Confirmation Email:** Trigger an email to the customer with their order summary, delivery timeframe (1–2 business days), Australia Post Express notice, and invoice receipt.
* **Files to Modify:**
  - Backend: `src/modules/mail/mail.service.ts`
  - Backend: `src/modules/carrier/carrier.service.ts` or dedicated order controller.

---

### Task 2: Admin Portal Device Orders Section (0.5 Day) — 🟢 Unblocked
* **Objective:** Give JustMobile staff visibility into hardware phone purchases.
* **Requirements:**
  1. Add a **"Handset Orders"** tab / sub-view in the Admin Operations Console (`/admin`).
  2. Table displaying:
     - Order ID & Date
     - Customer Name & `custNo`
     - Device Model, Colour, Storage & Amount
     - Delivery Shipping Address
     - Status: `PENDING_DISPATCH` vs `DISPATCHED`
     - Action: Input field to attach an **Australia Post tracking number** (e.g., `AP-74910284`) which updates the order and sends a shipping notice email to the customer.
* **Files to Modify:**
  - Frontend: `src/app/admin/page.tsx` & `src/app/admin/admin.module.css`
  - Backend: `src/modules/carrier/carrier.controller.ts` (list & update device orders).

---

### Task 3: Port-In Donor Rejection Error Alerts (0.25 Day) — 🟢 Unblocked
* **Objective:** Polish carrier edge cases where a donor carrier (Optus, Telstra, Vodafone) rejects an MNP transfer.
* **Requirements:**
  1. If an order in MongoDB is flagged as `REJECTED` by Octane/donor network (e.g. due to incorrect Date of Birth for prepaid or invalid Account Reference Number for postpaid):
     - Display a prominent error banner in `/account`: *"Transfer rejected by previous carrier: [Reason]. Please check and update your details."*
     - Provide an in-portal action button: **"Update Details & Resubmit Port"**.
* **Files to Modify:**
  - Frontend: `src/app/account/page.tsx`
  - Backend: `src/modules/carrier/carrier-porting.worker.ts`

---

### Task 4: Westpac QuickStream Payment Integration (0.5–1.0 Day) — 🟡 Documented & Awaiting Client Go-Ahead
* **Objective:** Implement secure card tokenization via Telcoinabox's native Westpac QuickStream gateway for automated recurring billing on the 28th cycle.
* **Architecture Reference:** Detailed specification documented in [`docs/PAYMENT_ARCHITECTURE_WESTPAC_QUICKSTREAM.md`](file:///d:/Just-Mobile-Development/docs/PAYMENT_ARCHITECTURE_WESTPAC_QUICKSTREAM.md).
* **Key Findings from Legacy Analysis (`bele-backend` & `justmobile`):**
  - Gateway is native to Telcoinabox (`paymentProvider: "QS"`).
  - All keys are already active: `groupNo: 922`, `supplierBusinessCode: C01967`, `TIABREST`, Quickstream secret and public keys.
  - The Westpac iframe (`createTrustedFrame`) handles card tokenization only (amount is never in the iframe).
  - Registering the token via `/api/v1/group/922/customer/{custNo}/payment-method` enables Telcoinabox's automatic recurring monthly billing engine on the 28th.
* **Requirements:**
  1. **Backend (`just-mobile-development-BE`):**
     - Add `payment` module (`POST /api/carrier/payment/method` calling Octane API).
  2. **Frontend (`just-mobile-development-FE`):**
     - Embed `createTrustedFrame` in Step 3 of `OrderFlowModal.tsx` and in `/account` for updating card on file.

---

### Task 5: Live Wholesale SIM Pilot Test (`TELCO_LIVE_CREATE=true`) — ✅ Completed & Verified
* **Status:** Verified in live production on Telcoinabox wholesale with Customer Number `551059` registered under Syed Yaseen Jamal (`yaseen@neximet.com`).
* **Safe State:** Flag safely reverted to `TELCO_LIVE_CREATE=false` in `.env` to protect development testing from unintended carrier charges.

---

## 4. Completed Foundation (100% Verified)

1. **Carrier Stack:** 19 Octane SOAP/REST carrier endpoints fully implemented and operational.
2. **ACMA TCP C628 2FA:** Pre-port 6-digit SMS verification with transaction verification tokens.
3. **Digital eSIM Engine:** Instant GSMA LPA string and high-resolution PNG QR generation + Hostinger SMTP welcome email dispatch.
4. **ATO Tax Invoices:** Dynamic `pdfkit` PDF engine with ABN 48 672 819 204, 10% GST breakdown, and download buttons in `/account`.
5. **Durable Worker:** Background porting status worker (`CarrierPortingWorker`) auto-checking carrier release every 30 seconds.
6. **Handset E-Commerce UX:** Handsets configured as direct outright purchases with clean pricing and zero lock-in contracts.
7. **Rate Cards & Policies:** Aligned with Octane wholesale cards ($19 / $25 / $40) with Zero Bill Shock; 500GB rollover claims removed.

---

## 5. Next Steps for Tomorrow

1. Start immediately with **Task 1** (Handset Warehouse & Dispatch Emails) and **Task 2** (Admin Portal Device Orders).
2. Follow with **Task 3** (Donor Port Rejection error handling).
3. Connect with the client to obtain **Stripe API keys** (Task 4) and sign-off for **Live Wholesale Carrier Testing** (Task 5).

