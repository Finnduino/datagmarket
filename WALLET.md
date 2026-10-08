# Wallet and guild events

- Wallet: /wallet. Send DGC to a selected trader, or scan/share a Receive QR.
  A request QR pre-fills the recipient and amount; the payer still confirms.
  The balance and payment history refresh every 10 seconds while the page is visible.
- Events: /events. Admins create an event with its opening/closing times,
  reward per attendee, total reward budget, and DGC entry price.
  Zero reward or entry price disables that feature.
- Permissions: select an event's Permissions button, search a trader, and
  independently enable participation rewards and/or entry check-in.
  The grant allowance is the total that staff member can issue for that event,
  not a per-payment limit. Already-issued rewards count toward it.
  Uncheck both permissions to revoke access. A moderator role alone does not
  grant access to event funds; admins can operate every event.
- Event desk: grant one reward per attendee per event, by username or Receive QR.
  Non-admin staff cannot reward themselves. Rewards come from the HOUSE treasury;
  both the event budget and staff allowance are enforced. Budgets are limits,
  not reserved treasury funds.
- Entry: the attendee generates a five-minute entry QR and authorises the shown
  price. Staff scan it, review the attendee's name, and confirm the charge.
  DGC moves back to HOUSE and the attendee is marked checked in.
  Repeated scans cannot charge again. A changed price requires a new QR.
  This is guild check-in tracking, not an integration with external ticket sellers.
- Admin: /organizer has separate Markets, Team permissions, and Audit ledger tabs.
  Transfers, rewards, entries, event configuration and permission changes are
  audited. Balance-changing operations are atomic SQLite transactions.

QR scanning supports camera access over HTTPS, image upload, and pasted links.
Camera access still requires the user's browser permission.
QR libraries are vendored locally in public/vendor with their licenses.

Run npm run check and npm test. Tests start an isolated server/database and never
touch production balances. SQLite schema additions are automatic and additive.
