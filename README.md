<!-- SXM Rentals — Created by Giordano Bertin-Maurice
     Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
     WHAT THIS FILE DOES: The starting point for anybody opening this folder for
     the first time. How to run the backend, what is in it, what is finished and
     what deliberately is not, and the rules the code must keep holding. -->

# SXM Rentals — Backend

The API behind the SXM Rentals website, admin panel and phone app. Fastify on
Node, Postgres on Neon, TypeScript throughout.

**Phases 1 to 3 are built.** Phase 1 is the foundation: the server, the complete
database layout, accounts and sign-in, and the security protections every later
feature sits behind. Phase 2 is the heart of the product: browsing and searching
cars, working out what a rental costs, and making a booking. Phase 3 is the
money: charging for a rental, holding a security deposit, and dealing with what
Stripe tells us afterwards.

Identity checks, the business dashboard, admin tools, rewards, notifications and
the support agent arrive in later phases; their folders exist as clearly marked
placeholders.

**Stripe is not connected yet.** Until `STRIPE_SECRET_KEY` is set, the payment
and deposit endpoints answer "not switched on yet" rather than appearing to take
money. Everything about them is already tested, against a stand-in Stripe that
needs no account and no keys.

---

## Running it

```bash
npm install
cp .env.example .env     # then fill in the values (see "Settings")
npm run db:migrate       # build the tables
npm run dev              # http://localhost:3000/api/v1/health
```

No database to hand? Leave `DATABASE_URL` empty. In development the backend then
uses a small built-in Postgres kept on your computer in `.data/`, so it runs with
no setup at all. Set `DATABASE_URL` to your own Neon branch to use the real thing.

| Command | What it does |
|---|---|
| `npm run dev` | The API, restarting as you save |
| `npm run build` | The production build, into `dist/`. Fails on a type error |
| `npm start` | Runs what `build` produced |
| `npm run typecheck` | Types only, no build |
| `npm test` | The test suite, once (each test file gets its own fresh database) |
| `npm run test:watch` | The test suite, re-running as files change |
| `npm run db:generate` | Writes a new SQL migration after you change `src/db/schema/` |
| `npm run db:migrate` | Applies any migrations not yet applied |

Node 20.11 or newer. Nothing is deployed anywhere; everything stays on localhost
until it has been reviewed.

**Migrations never run by themselves.** The server does not touch the database
layout when it starts. On deploy, `npm run db:migrate` is its own explicit step
before the new version goes live.

---

## Settings

All settings come from the environment (a `.env` file locally). `.env.example`
lists every one with an explanation. The server refuses to start, with a
readable list, if any are wrong — and production is stricter: it requires
`DATABASE_URL` and only accepts `https://` website addresses.

| Setting | What it is |
|---|---|
| `DATABASE_URL` | Your Neon branch. Empty in development = built-in local database |
| `CORS_ORIGINS` | The websites allowed to call the API from a browser, comma separated |
| `APP_URL` | The customer website, for links inside emails |
| `TRUST_PROXY_HOPS` | Proxies in front of the server (Render = 1), to see real visitor addresses |
| `BREACHED_PASSWORD_CHECK` | `false` skips the leaked-password check (e.g. offline) |
| `STRIPE_SECRET_KEY` | Empty until Stripe is connected. Use the test key (`sk_test_…`) everywhere but production |
| `STRIPE_WEBHOOK_SECRET` | From Stripe's webhook settings. Without it, Stripe's messages are refused |
| `CURRENCY` | What bookings are charged in (`usd`) |

Never put a real secret in `.env.example` or anywhere else git can see.

---

## How the folders are arranged

```
src/
  server.ts            starts the real server
  app.ts               assembles the API in protection order (tests use it too)
  config.ts            reads and checks the settings
  db/
    schema/            every table, one file per area — see schema/index.ts
    migrations/        the SQL that builds those tables, in order
    client.ts          the connection (Neon, or the built-in Postgres)
  middleware/
    auth.ts            who is making this request; forged-request check
    error-handler.ts   the one error shape
  plugins/             security headers, CORS, rate limiting, logging
  routes/              the web addresses, under /api/v1
  services/            the business logic, kept out of the routes
    auth/              accounts, sign-in, sessions
    availability-engine/  is this car free, and which days are taken
    booking-engine/    what a rental costs, and making the booking
    payments/          charges, deposit holds, and what Stripe tells us after
    serializers/       database rows → the exact shapes the apps expect
  lib/                 small shared tools: passwords, codes, errors, email, Stripe
  types/api.ts         the response shapes, copied from sxm-rentals-web
test/
  auth.test.ts         every account journey, from the outside
  vehicles.test.ts     searching, filtering, availability, reviews
  bookings.test.ts     prices, making and cancelling bookings, double-booking
  payments.test.ts     charges, deposit holds, claims, Stripe's messages
  security.test.ts     headers, CORS, forged requests, rate limits, errors
  rules/               the three product rules
```

Every request passes through, in order: security headers and CORS → rate limit →
forged-request check and "who is this" → the route → one error shape.

---

## What the API does so far

Everything lives under `/api/v1`.

| Method | Address | What it does |
|---|---|---|
| GET | `/health` | Is the API up and can it reach the database |
| POST | `/auth/signup` | Create an account; a confirmation link is emailed |
| POST | `/auth/verify-email` | Confirm the email with the link's code |
| POST | `/auth/verify-email/resend` | Send a new confirmation link |
| POST | `/auth/login` | Sign in |
| POST | `/auth/logout` | Sign out of this device |
| POST | `/auth/logout-all` | Sign out of every device |
| POST | `/auth/password/forgot` | Email a password-reset link |
| POST | `/auth/password/reset` | Choose a new password with that link |
| POST | `/auth/password/change` | Change password while signed in |
| GET | `/auth/sessions` | The devices you are signed in on |
| DELETE | `/auth/sessions/:id` | Sign out one of them |
| GET | `/customers/me` | Your own account, in the apps' `User` shape |
| GET | `/vehicles` | Search and filter cars — every filter the Search screen offers |
| GET | `/vehicles/:id` | One car, with its photos, declared damage and booked days |
| GET | `/vehicles/:id/reviews` | Its reviews |
| GET | `/providers` | The rental businesses |
| GET | `/providers/:id` | One business's public page |
| POST | `/bookings/quote` | What a rental would cost, before booking anything |
| POST | `/bookings` | Make a booking |
| GET | `/bookings` | Your own bookings |
| GET | `/bookings/:id` | One of your own bookings |
| POST | `/bookings/:id/cancel` | Cancel one that has not started |
| POST | `/payments/bookings/:id/intent` | Start (or resume) paying for a booking |
| POST | `/deposits/bookings/:id/authorize` | Place the deposit hold on the card |
| GET | `/deposits/bookings/:id` | What is being held, and its state |
| POST | `/deposits/:id/release` | Give a deposit back — **staff only** |
| POST | `/deposits/:id/claim` | Keep part of one — **staff only** |
| POST | `/webhooks/stripe` | What Stripe tells us happened |

Browsing is public: somebody searching for a car has not signed in yet, and a
search result needs to be able to appear in Google. Only cars staff have
approved are ever returned, and lists are capped and paged. Everything to do
with a booking needs you to be signed in.

**What a rental costs.** Whole weeks at the business's weekly price where they
offer one, then the remaining days at the daily price, plus a 5% SXM Rentals
service fee. **Delivery is free** — a business can bring the car to the customer
at no charge, so there is no delivery line and no delivery fee is reported to
any screen. SXM Rentals keeps 30% of the total (a platform setting), and the
rest is the business's, to the cent. **The deposit is never part of any of
that**; it comes back beside the total.

**The same car cannot be booked twice.** A booking locks the car's record while
it checks, so two people booking the same days at the same instant cannot both
succeed — the second gets a clear "just been booked". A rental from the 1st to
the 4th uses the nights of the 1st, 2nd and 3rd, so the 4th is free for the next
person to collect.

---

## How the money works

**Card details never touch this server.** A payment endpoint hands the app a
one-time "client secret"; the app gives that to Stripe's own card form, and the
card number goes straight from the customer's device to Stripe. That is what
keeps SXM Rentals out of the strictest card-handling rules.

**The rental is charged. The deposit is only held.** They are two separate
payments at Stripe, on purpose:

| | The rental | The security deposit |
|---|---|---|
| What happens | Taken from the card | Set aside on the card, never taken |
| Whose money | Split between the business and SXM Rentals | The customer's, throughout |
| Where it lives | On the booking, in the ledger | Its own `deposits` row, its own life cycle |
| Ending | Paid, or refunded | Released in full, or part kept after a written claim |

Keeping any part of a deposit needs a written reason, is never more than was
held, and is a staff decision — never a customer's or a business's. The database
refuses a claim without a reason, and the release and claim endpoints sit behind
the staff check, which refuses everyone until staff sign-in is built.

**A booking is only ever marked paid because Stripe said so.** A card can be
declined, or need the bank's approval, after the customer has closed the page,
so nothing is believed because an app said it worked. Stripe's message is signed
and the signature is checked against our own secret; an unsigned or altered one
is refused outright, which is what stops a stranger simply announcing that a
booking has been paid for. Stripe resends a message when it is unsure we got it,
so every message is recorded and a repeat changes nothing.

**The website and the phone app sign in differently.** The website gets an
httpOnly cookie that page scripts cannot read. The phone app sends
`"client": "mobile"` and gets its sign-in code in the response, to keep in the
phone's secure storage and send back as `Authorization: Bearer <code>`.

**Every error looks the same:**

```json
{ "error": { "code": "rate_limited", "message": "Too many attempts...", "requestId": "…", "details": { } } }
```

`code` is stable for the apps to switch on; `message` is safe to show a person;
`requestId` matches the server's log line. An unexpected failure never reveals
anything about why.

**Emails are not really sent yet.** In development they are printed to the
terminal, so you can click the link. In production, with no provider connected,
they are refused and logged (without their contents). Resend or Postmark plugs
into `src/lib/email.ts`.

---

## The three product rules

The same three rules as the website, admin panel and phone app. The backend has
to hold them up too, and each has a test in `test/rules/`. **If one of those
tests fails, a rule has been broken — do not change the test.**

**1. A security deposit is never revenue.** Deposits live in their own table with
their own life cycle. The `bookings` table has no deposit column at all, so a
deposit cannot be summed into a total, a commission or a payout. Keeping a
deposit without a written reason is refused by the database.

**2. A rental business never sees a customer's phone number or email.** The
business's view of a booking is built field by field in
`src/services/serializers/bookings.ts`, from a renter summary with no contact
fields. Even handing it a whole customer record cannot leak one.

**3. Every figure shown to a business is their own share.** Gross, commission and
net always travel together, and the database refuses any booking or payout where
the business's share plus the commission is not exactly what the customer paid.

---

## Security — where Phase 1 stands

Mapped to the Phase 1 list in the Security Hardening Spec.

| Item | Status |
|---|---|
| Tenant isolation / IDOR | Done: `lib/ownership.ts` — someone else's record answers "not found", exactly like a missing one. Business membership is checked against `provider_members`. Every later route must use it |
| Password storage | Done: Argon2id, OWASP cost settings |
| Password rules | Done: 12+ characters, no composition rules, leaked passwords refused (HaveIBeenPwned, k-anonymity; skipped with a warning if unreachable) |
| Sessions | Done: random 256-bit codes, only fingerprints stored; httpOnly, Secure and SameSite cookies; 7-day idle / 30-day absolute expiry; new code on every sign-in; checked against the database on every request |
| Sign-out | Done: this device, one chosen device, or all |
| Password reset | Done: single-use, 30-minute links; never reveals whether an account exists; signs out every device |
| Account lockout | Done: from the 5th wrong password in a row, locked for 1, 2, 4… minutes, up to an hour |
| Email ownership | Done: sign-in requires a confirmed email |
| Rate limiting | Done: per address, stored in the shared database so it holds across servers; tight limits on every account route; `429` with `Retry-After` |
| Secrets | Done: settings only from the environment; `.env` git-ignored; logs blank out passwords, codes and cookies |
| Security headers | Done: HSTS, a nothing-allowed CSP, `nosniff`, frame blocking, no-referrer, permissions policy, `no-store` |
| CORS | Done: our own websites only, never a wildcard |
| Forged cross-site requests | Done: cookie-signed changes must come from one of our websites |
| Input validation | Done for every current route (Zod) |
| Card data | Never touches this server: the apps send it straight to Stripe with a one-time secret |
| Signed webhooks | Done: Stripe's messages are verified against our signing secret over the exact bytes sent, and a repeat is recorded and ignored |
| AI budget caps | Not yet: there are no AI calls yet (Phase 8) |

**Deliberately not built yet:**

- **Staff sign-in.** The admin panel's separate sign-in, with mandatory two-factor
  codes, is Phase 2. Until then `requireAdmin` refuses everyone, so an admin
  route added early cannot be reached.
- **Sign in with Apple and Google.** Needs developer-account keys.
- **A real email provider** (see above).
- **Paying businesses (Stripe Connect).** Each booking already records what the
  business is owed and what SXM Rentals keeps; onboarding businesses to Stripe
  and sending the money arrives with the business dashboard in Phase 5.
- **Everything past payments** — identity checks, the business dashboard, admin
  tools, rewards, notifications and the support agent.

**Known dependency advisory:** `npm audit` reports 4 moderate advisories, all
inside `drizzle-kit` (the migration generator). It bundles an old esbuild with a
development-server issue. It is a development tool only, is never part of the
running API, and we never run its dev server. Revisit when drizzle-kit updates.

---

## A note on the file headers

Every file opens with three lines: who wrote it, the copyright, and a
plain-language description of what the file does — written so somebody who is
not a developer can read it. Inside a file, each meaningful block is labelled
for what it does in the same plain words. Keep the description when you edit a
file; rewrite it when the file's job changes.

The attribution belongs in the source and nowhere else — never in an API
response or anything an app shows.
