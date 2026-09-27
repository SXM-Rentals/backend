<!-- SXM Rentals — Created by Giordano Bertin-Maurice
     Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
     WHAT THIS FILE DOES: Hands over the backend work the admin panel is waiting
     on — part one, managing staff accounts (SHIPPED); part two, admin tiers; and
     part three, a rental business's details and closing one. Written for whoever
     builds it, a developer or an AI coding assistant, who has not seen the admin
     panel. Everything needed is in here. -->

# Handoff — staff accounts, managed from the admin panel

## The job in one paragraph

Today the only way to add a staff member is `npm run admin:create`, run by hand
against the live database, and there is **no way at all** to change a staff
password, reset one, recover from a lost authenticator app, or remove somebody
who has left. The owner wants all of that done from the admin panel instead.
The panel side is **already built** and calls exactly the addresses described
below; until this backend work ships, those screens say "the server does not
offer this yet". The job is: one migration, six addresses, one rule enforced on
every admin request, one small command, and the tests.

---

## Rules that come with this repo (not optional)

- **File headers.** Every file opens with the three-line header used throughout
  this repo: `SXM Rentals — Created by Giordano Bertin-Maurice`, the copyright
  line, and `WHAT THIS FILE DOES:` in plain words a non-developer can read.
- **Commits** are authored as `gio <jeeordahnoh@gmail.com>`, with a plain-English
  body, and **never** a `Co-Authored-By` line.
- **Local first.** Nothing is pushed until the owner has reviewed it. Render
  deploys from GitHub, so a push is a deploy — and this one changes the database.
- **Every staff change carries a written reason** and is written into the audit
  log by `recordAudit`. A password, a code or a secret is **never** written into
  the audit log, a response, or a log line.

---

## The decision this reverses — and what keeps it safe

`src/scripts/create-admin.ts` says: *"There is deliberately NO web address that
creates a staff account … so nobody can grant themselves admin access through
the panel or the API."* The owner has decided to change that, to stop needing a
terminal and the live database address for everyday staff changes. It is a
reasonable decision **only with all of the following**, so none of them is
optional:

1. **Only a signed-in staff member can do it** — both sign-in steps passed,
   exactly like every other admin address (`requireAdmin`).
2. **Every change to a staff account also needs the actor's own authenticator
   code, fresh, in the request** (`code`). A stolen or left-open session is then
   not enough to mint a new admin, reset a colleague, or lock everyone out.
   Wrong codes count towards the same lockout as wrong sign-ins.
3. **A new or reset account must set its own password on first sign-in**
   (`must_change_password`). The person who created it knows the temporary
   password; if that stayed the working password, two people could act as one
   account, and the audit log's "who did what" would stop meaning anything.
4. **Nobody can disable or reset their own account** from the panel — so the
   panel can never lock out the last person able to fix things.
5. **`npm run admin:create` stays exactly as it is**, and a matching
   `npm run admin:reset` is added (below): the way back in if every account is
   disabled or the only admin loses their phone.

---

## The database change — migration `0005`

Edit the schema, then generate the migration with `npm run db:generate` (the
repo's drizzle-kit setup) so the journal in `src/db/migrations/meta` stays right.

In `src/db/schema/admin.ts`, on `adminStaff`:

```ts
// True for an account created or reset from the admin panel, until its owner
// sets a password of their own. Nothing else can be done until then.
mustChangePassword: boolean('must_change_password').notNull().default(false),
```

In `src/db/schema/enums.ts`, add to `auditAction`:
`'staff_created'`, `'staff_reset'`, `'staff_disabled'`, `'staff_enabled'`,
`'password_changed'` — and add `'staff'` to `auditSubjectType`.

Existing accounts get `false`, so nobody is interrupted. **Check the generated
SQL runs on both databases**: Neon in production and PGlite in `npm test`.
Postgres will not let a transaction *use* an enum value it has just added, so
keep the `ALTER TYPE … ADD VALUE` statements free of anything that uses them.

---

## The shape every staff address answers with

```json
{
  "id": "0b8c…uuid",
  "name": "Carla Ruiz",
  "email": "carla@sxmrentals.app",
  "avatarInitials": "CR",
  "mfaEnrolled": false,
  "mustChangePassword": true,
  "lastSignInAt": null,
  "createdAt": "2026-09-22T15:00:00.000Z",
  "disabledAt": null
}
```

`mfaEnrolled` is `mfaEnrolledAt !== null`. Dates are ISO strings or `null`.
Never include `passwordHash`, `mfaSecretEncrypted`, `failedLoginCount` or
`lockedUntil`.

---

## Every new or changed address

All under `/api/v1/admin`. All require the staff sign-in. The write addresses
use the existing `AUTH_LIMITS.passwordChange` rate limit.

| | Address | Body | Answers |
|---|---|---|---|
| changed | `GET /me` | — | Adds `avatarInitials` and `mustChangePassword` to today's `{ id, name, email }`. |
| changed | `POST /auth/mfa/verify` | unchanged | Adds `mustChangePassword` beside `staff` and `expiresAt`. |
| changed | `GET /staff?status=` | — | `status` is `active` (the default — unchanged for existing callers), `disabled` or `all`. Returns the full shape above, ordered by name. |
| new | `POST /staff` | `{ name, email, password, reason, code }` | `201` with the new account. |
| new | `POST /staff/:id/reset` | `{ password, resetAuthenticator, reason, code }` | `200` with the account. |
| new | `POST /staff/:id/disable` | `{ reason, code }` | `200` with the account. |
| new | `POST /staff/:id/enable` | `{ reason, code }` | `200` with the account. |
| new | `POST /auth/password` | `{ currentPassword, newPassword }` | `204`. |

### Adding a staff member — `POST /staff`

- `name` trimmed, 1–120 characters. `email` a valid address, stored lower-case.
- `password` is the **temporary** password, 12–128 characters
  (`PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH`), refused if it is in a known
  breach (`400 password_breached`, the same check customers get).
- `reason` 3–1000 characters, like every other change. `code` is the actor's
  current six-digit authenticator code.
- An email already in use → `409 staff_exists` (reuse `createStaff`'s message).
- Creates the account with `mustChangePassword: true` and **no** authenticator:
  they set one up on first sign-in through the existing enrol step.
- Audit: `staff_created`, subject `staff` / the new id / `Staff · Carla Ruiz`,
  field `Staff account`, before `Did not exist`, after `Created`.

### Resetting a staff member's sign-in — `POST /staff/:id/reset`

For a forgotten password or a lost phone.

- Your own id → `409 cannot_reset_self`: *"Use Change password for your own
  account."*
- Sets the new temporary `password` (same rules as above) and
  `mustChangePassword: true`, clears `failedLoginCount` and `lockedUntil`.
- `resetAuthenticator: true` also clears `mfaSecretEncrypted` and
  `mfaEnrolledAt`, so they set up an authenticator again at next sign-in.
- **Revokes every session they have** (`revokedAt` on all their
  `admin_sessions` rows).
- Audit: `staff_reset`, field `Sign-in`, before `Working`, after
  `Temporary password issued` (+ `, authenticator reset` when it was).

### Disabling and re-enabling — `POST /staff/:id/disable` and `/enable`

- Disabling your own id → `409 cannot_disable_self`.
- Disable when already disabled → `409 already_disabled`; enable when not →
  `409 not_disabled`.
- Disable sets `disabledAt` and **revokes every session they have**. Sign-in
  already refuses disabled accounts, and `loadSession` already ignores them.
- Enable clears `disabledAt` only. It does not change their password — if they
  need a new one, that is a reset.
- Audit: `staff_disabled` / `staff_enabled`, field `Access`, before and after
  `Active` / `Disabled`.

### Changing your own password — `POST /auth/password`

Mirror the customer `changePassword` in `src/services/auth/index.ts`:

- Wrong `currentPassword` → **`400 wrong_current_password`** (the customer code
  and message) and `recordFailure`, so it counts towards the lockout.
- `newPassword` 12–128, breach-checked, and the same as the current one →
  `400 same_password`: *"Choose a password you have not been using."*
- On success: new hash, `mustChangePassword: false`, `clearFailures`, and
  **revoke every other session of theirs — this one carries on** (keep
  `actor.sessionId`).
- Audit: `password_changed`, subject the staff member themselves, field
  `Password`, before `—`, after `Changed`, with the server supplying the reason
  `Changed their own password.` — there is nothing useful to ask them for.

---

## Two errors that must NOT be 401 — the panel depends on this

The panel treats **any `401`** from an admin address as *"your session has
ended"* and puts a sign-in over the screen. Inside a signed-in session, a wrong
password or a wrong code is not that — it is a typo. So:

| Situation | Answer |
|---|---|
| Wrong `currentPassword` on `POST /auth/password` | `400 wrong_current_password` |
| Wrong `code` on any staff-account change | `400 wrong_code` — *"That code is not correct."* |
| Account locked by too many wrong attempts | `429` with `Retry-After`, as sign-in does |

The existing `invalidCredentials()` (a `401`) is for signing in only. Do not
reuse it for these.

**The step-up check**, in `services/admin/auth.ts` next to `confirmMfa`: load the
actor's `mfaSecretEncrypted`, refuse if locked, `decryptSecret`, `verifyOtp` with
the same `MFA_CLOCK_TOLERANCE_SECONDS`, `recordFailure` on a wrong code, and do
**not** `clearFailures` on success (that belongs to signing in).

---

## The "set your own password first" rule

While an account has `mustChangePassword: true`, **every admin address except**
`GET /me`, `POST /auth/password` and `POST /auth/logout` answers:

```
403 password_change_required — "Set your own password before carrying on."
```

The natural place is `authenticate` in `services/admin/auth.ts` (carry the flag
on `AdminActor`) with the check in `requireAdmin`, plus a way for those three
addresses to opt out. The panel reads `mustChangePassword` from `/me` and from
`/auth/mfa/verify`, and shows a "set your own password" screen before anything
else.

---

## One more, small: cap how long a lockout lasts

`LOCK_AFTER_FAILURES` and `MAX_LOCK_MINUTES` in `services/admin/auth.ts` lock an
account for twice as long on each failure after the fifth, up to **an hour**. Cap
it at **ten minutes** instead (`MAX_LOCK_MINUTES = 10`), and leave everything
else about the lockout as it is.

Two reasons, and the second is new:

- A member of staff who simply mistypes their password five times should not lose
  the panel for the rest of the morning. Ten minutes is long enough to make
  guessing pointless and short enough to sit through.
- **The sign-in page is now reachable from the internet.** Vercel's own login
  used to stand in front of the whole panel; it is being set to leave this
  address to the panel's own sign-in. That is fine — a password alone gets
  nobody in without an authenticator code — but it does mean anybody who knows a
  staff email address can make wrong attempts against it. With an hour's lock
  they could keep a colleague out all day for no effort; with ten minutes it is
  a nuisance and nothing more.

Guessing is still hopeless either way: five attempts buys a stranger nothing
against a password they do not have, and the code is a second thing they also
do not have.

## The way back in — `npm run admin:reset`

A new command beside `admin:create`, for when the panel cannot help: every
account disabled, or the only admin has lost their phone.

```bash
npm run admin:reset -- name@example.com 'a new temporary passphrase' [--authenticator]
```

It does what `POST /staff/:id/reset` does (and also clears `disabledAt`), with
the same password rules, and prints what it changed. Like `admin:create` it has
no acting staff member, so it writes no audit entry — it is server access, which
is outside what the panel's audit log covers. Add it to the README's command
table and to its "admin panel" section.

**It needs the live `DATABASE_URL`.** With that unset, both commands quietly use
the local `.data/pglite` database instead, and the account appears to work but
does not exist on the live server. Say so in the command's own output when
`DATABASE_URL` is empty.

---

## Logging

`src/plugins/request-logging.ts` already blanks `*.password`, `*.currentPassword`
and `*.newPassword` — which is why the temporary password field above is called
`password`. **Add `'*.code'`**: authenticator codes are short-lived, but they are
still secrets in transit and do not belong in a log.

---

## Tests to add (in `test/admin.test.ts` or a new `test/admin-staff.test.ts`)

- Adding a staff member without a code, with a wrong code, or without a reason
  is refused, and changes nothing. A wrong code counts towards the lockout.
- A new account can sign in only as far as setting a password: every other admin
  address answers `403 password_change_required` until it has.
- After changing it, everything works, the temporary password no longer does,
  and other sessions of that account are signed out — this one is not.
- A wrong current password answers `400`, **not** `401`.
- Nobody can disable or reset themselves.
- Disabling signs the person out everywhere and stops them signing in; enabling
  lets them back in.
- A reset with `resetAuthenticator` makes them set up an authenticator again.
- Every change above writes one audit entry with the reason — and no audit
  entry, response or log line anywhere contains a password or a code.
- A customer's session can use none of these addresses.
- `GET /staff` with no `status` still returns only active staff (the dispute
  picker relies on it).

---

---

# Part two — tiers, so not everybody can do everything

**This can ship after everything above, and should.** Part one replaces a
terminal with a screen. This part changes what the panel *is*: today there is one
flat access level, and the panel says so in several places. The trade it rests on
is accountability rather than restriction — everybody can do everything, and
everything anybody does is on the record with a reason. Tiers add restriction on
top of that record; they do not replace it. The audit log stays exactly as it is
for every tier.

## The four tiers, highest first

| Tier | What it is for | What it can do |
|---|---|---|
| `godfather` | The owner of the business. **Exactly one account.** | Everything, including making and unmaking Owners. |
| `owner` | Somebody trusted with the business, not just the day's work. | Everything an Administrator can do, plus platform settings, plus adding, resetting, removing and re-tiering Administrators and Viewers. |
| `administrator` | The everyday job. | Verifications, vehicle listings, refunds, deposits, disputes, customer records. No staff management, no platform settings. |
| `viewer` | Somebody who needs to see but not touch — a bookkeeper, somebody being trained. | Reads everything. Changes nothing at all. |

Store it on `admin_staff` as a `pgEnum('admin_tier', ['godfather', 'owner',
'administrator', 'viewer'])`, migration `0006`. **The migration must set the one
existing account to `godfather`** and default new rows to `administrator`.

## The rules that stop a tier system becoming a way in

These matter more than the table above. Without them, tiers are a hierarchy
anybody can climb.

1. **Nobody may act on an account at their own tier or above.** An Administrator
   cannot reset an Owner; an Owner cannot disable the Godfather, or another
   Owner. Refuse with `403 not_allowed` and a sentence saying who can.
2. **Nobody may grant a tier at or above their own.** An Owner cannot make
   somebody an Owner, and nothing in the panel can grant `godfather` at all — it
   moves by a server command only, deliberately and rarely.
3. **Nobody may change their own tier**, even the Godfather. It is the one change
   that has to come from somebody else.
4. **`godfather` is unique.** Enforce it in the database — a partial unique index
   on `tier` where `tier = 'godfather'` — not only in code.
5. **The Godfather account cannot be disabled or reset by anybody else**, so the
   panel can never lock out the business's owner.
6. **A tier change is a change like any other**: a reason, the actor's
   authenticator code, and an audit entry. Add `staff_tier_changed` to
   `auditAction`, recording the tier before and after in words.

## How to enforce it, in one place rather than forty

- **Viewers are read-only, by method, not by route.** In the `preHandler` that
  already blocks forged requests, refuse any non-`GET` admin request from a
  Viewer with `403 read_only`: *"Your account can see the panel but not change
  anything."* That is one rule covering every address, including any added later
   — far safer than remembering a check per route.
- **Everything else is a minimum tier per address**, declared next to the route
  rather than buried in the service, so the list can be read in one sitting.
  Suggested: platform settings and all staff management → `owner`; everything
  else that changes something → `administrator`.
- `GET /me` returns `tier`. `GET /staff` includes it. `POST /staff` takes it
  (refused if at or above the actor's own). New: `POST /staff/:id/tier` with
  `{ tier, reason, code }`.

## Two decisions — both settled by the owner

1. **A Viewer sees everything, including the audit log.** Read-only means exactly
   that and nothing narrower: the audit log, every booking, every figure, and
   customer contact details along with them. There is no field a Viewer is kept
   away from, so no per-field rules to write. If that ever needs narrowing —
   money without contact details, for a bookkeeper — it is a different and much
   larger job than a tier check, and should be asked for as one.
2. **An Administrator moves money**: approves and denies refunds, and releases or
   keeps deposits, as the table above says. It is the everyday job, and every one
   of those changes already carries a reason and an audit entry naming who made
   it. No amount threshold and no second approval.

## Tests to add for tiers

- A Viewer is refused on every kind of change, including one added later: assert
  the rule is by method, not by a list of routes.
- An Administrator cannot reach staff management or platform settings.
- An Owner cannot disable, reset or re-tier another Owner or the Godfather, and
  cannot make anybody an Owner.
- Nobody can change their own tier, and no second `godfather` can be created —
  by the API or by a direct insert.
- The Godfather cannot be disabled or reset by anybody else.
- Every tier change writes an audit entry with the reason and the tiers in words.

## What changes in the admin panel (a separate job, in that repository)

The panel will need: the tier shown against each person and chosen when adding
one, a "Change tier" action, and every action a person's tier forbids hidden —
while still relying on the server's refusal as the real barrier. Several places
also say, in so many words, that there is one access level for everybody: the
account menu, `lib/auth.tsx`, the Settings screen and the Playbook. Those lines
become untrue the day this ships and must change with it.

---

## Suggested order

1. The migration and the schema.
2. The step-up check and `mustChangePassword` enforcement, with their tests.
3. `POST /auth/password`, then `GET /me` and `/auth/mfa/verify` gaining the flag.
4. `GET /staff?status=`, then the four staff-account changes.
5. `npm run admin:reset`, the logging line, the README.

## Done means

- `npm run typecheck` and `npm test` pass, on PGlite.
- The migration runs cleanly on the live Neon database (Render runs migrations
  before the new version starts serving).
- From the admin panel, the owner can add a staff member, who then signs in,
  sets their own password and authenticator, and appears in the audit log's
  staff list. A reset and a disable work, and each appears in the audit log with
  its reason.
- `npm run admin:reset` recovers an account with the live `DATABASE_URL`.
- The owner has reviewed it before anything is pushed.
---

# Part three — a rental business: fixing its details, and closing it

Written 27 September 2026, after part one shipped (`5b48e65`) and after
`6323724` gave businesses a way to close themselves.

## Where this came from

The owner asked for three things on a business in the admin panel: **edit**,
**restrict**, **delete**. Only one of the three could be built against the
addresses that exist, so only one was built:

| Asked for | Where it stands |
|---|---|
| **Restrict** | **Built and live in the panel.** "Stop This Business Trading" on the business screen sends `POST /admin/vehicles/:id/listing { approve: false, reason }` for every one of that business's live vehicles, one at a time, with one reason recorded against each. Nobody can book them from that moment. |
| **Edit** | **Not built.** There is no address for changing a business's details. The screen says so in one line. |
| **Delete / close** | **Not built**, even though this repo already knows how to do it — see below. The screen used to say "not connected yet"; it now offers the restrict action instead, and says in so many words that the account stays open. |

The three asks below are what would finish the job. **Ask one is small, and it
matters more than the other two**, because without it the panel is already
showing something untrue.

---

## Ask one — tell the admin panel when a business is closed

### The problem, plainly

`POST /providers/me/close` shipped in `6323724`. A business owner can close
their business from their own account today: every car is suspended and
`providers.deleted_at` is set.

The admin panel cannot tell. `toAdminProvider` in
`src/services/serializers/admin.ts` does not send `deletedAt`, and
`listProviders` in `src/services/admin/index.ts` does not filter on it or read
it. So a business that closed itself last week still appears in the panel as an
ordinary open business, its verification badge intact, with a fleet of cars that
are all "Suspended" and no reason anywhere for why. A staff member would ring
them to ask what happened to their listings.

That is a false statement on a screen, which is the one thing this project does
not allow anywhere else.

### What to do

1. In `toAdminProvider`, add `closedAt: provider.deletedAt?.toISOString() ?? null`.
2. Keep closed businesses **in** the list — do not filter them out. Staff need to
   look up a business that has gone, exactly as they can look up a closed
   customer account, because past bookings and payouts still point at it. (The
   customer list already works this way: a closed account stays in it, greyed
   out. Follow that.)
3. Nothing else. No migration: the column exists.

The panel will then mark those businesses closed, stop offering actions that
make no sense on one, and explain the suspended fleet.

---

## Ask two — `POST /admin/providers/:id/close`

### Why the panel cannot do this itself

Taking every car down is not closing a business. The cars come back the moment
anybody puts one live again, the business still appears as an ordinary open
business everywhere, and it can still list a new car tomorrow. What the panel
does today is the honest limit of what it can do, not the thing that was asked
for.

And **the work is already written**: `closeBusiness(db, providerId)` in
`src/services/provider/index.ts`. It refuses while a rental is upcoming or
active, while a deposit is held, or while a payout is pending — each refusal
naming the reference that is in the way — then suspends every vehicle and sets
`deleted_at`, in one transaction. That transaction is also strictly better than
what the panel does now: today, if the fourth of six take-downs fails, four cars
are down and two are live, and the panel has to say so.

### The address

```
POST /admin/providers/:id/close     { reason }        → the business, as GET /admin/providers/:id sends it
```

- `staff(request)` as every other admin address does, then the Origin check that
  already runs on every non-GET.
- `reason` uses the same `reason` schema as every other admin change (non-blank,
  at most 1000 characters) — the database enforces it anyway.
- Call `closeBusiness(db, id)`, then write the audit entry:
  `action: 'business_closed'`, `subjectType: 'provider'`,
  `subjectLabel: 'Business · <name>'`, `field: 'Status'`, `before: 'Open'`,
  `after: 'Closed'`, plus the reason and the staff id. **The audit entry is the
  whole point** — a business closing itself leaves no staff record, and a
  closure by staff must.
- Let `closeBusiness`'s own conflicts through untouched: `already_closed`,
  `has_live_rental`, `has_held_deposit`, `payout_pending`. The panel shows the
  server's message to the staff member word for word, so those sentences are
  what somebody reads on screen. They already read well; "A payment to you is
  still on its way" is the only one that needs rewording for this audience —
  staff are not the business — so consider "A payment to them is still on its
  way (REF)." and pass the audience in, or leave it and the panel will live
  with it.

### Say plainly whether it can be undone

Nothing in the repo reopens a business: `deleted_at` is set and there is no
address that clears it. So either

- **add `POST /admin/providers/:id/reopen { reason }`** — clear `deleted_at`,
  leave every car suspended (they must be put live one by one, deliberately),
  audit it; or
- **decide it is final**, and say so here.

Whichever it is, the panel must be told, because the confirmation dialog has to
say it out loud before somebody presses the button. A recommendation: add the
reopen. A business closed by mistake, or by the wrong owner in a family
argument, is a support call that currently needs a developer with database
access.

### Should it need the authenticator code?

The self-serve version asks the owner for their password again. The staff
version already carries a written reason and an audit entry, which is what every
other staff decision carries, so **reason only is consistent** and that is the
recommendation. If the owner wants the six digits as well, `verifyStepUp(actor,
code)` from part one is right there, and the panel's dialog turns it on with one
prop (`confirmWithCode`) — say which, and the panel will match.

---

## Ask three — `PATCH /admin/providers/:id`

### What it is for

A business's own details are the business's to change, from its own account.
Staff need it for one narrow job: fixing something wrong that the business
cannot or will not fix — a legal name spelled wrong on a payout, an email that
bounces, a phone number that has changed since a dispute was opened.

So this is not a "let staff run the business" feature, and the panel will not
present it as one.

### The address

Mirror `PATCH /admin/users/:id` exactly — same shape, same one-field-at-a-time
discipline, same audit entry:

```
PATCH /admin/providers/:id     { field, value, reason }   → the business, as GET sends it
```

`field` is an enum. What is on each table today:

- `providers`: `businessName`, `side`, `town`, `description`, `phone`,
  `respondsIn`, `deliversVehicles`, `airportPickup`
- `provider_business_profiles`: `legalName`, `contactEmail`, `website`,
  `registrationNumber`, `ownerName`, `ownerPhone`

**Not editable here, on purpose:**

- `verificationStatus` and `isVerified` — they have their own address, with
  their own decision and their own audit entry
  (`POST /admin/providers/:id/verification`). Two ways to set the same thing is
  how an audit log stops being trustworthy.
- `rating` and `reviewCount` — they are the sum of what customers said. A
  staff-editable rating is not a rating.
- `deletedAt` — ask two owns that.

A suggestion, not a requirement: start with the six profile fields plus
`phone`. Those are the ones a support call is actually about, and `side` or
`town` moving a business across the island is a bigger decision than a typo
fix.

The audit entry follows `updateUserField`: `field`, `before`, `after` as text,
subject label `Business · <name>`, the reason, the staff id.

---

## What the panel does when each of these lands

Nothing in the panel needs rebuilding — these are the honest lines that become
real actions:

1. **`closedAt`** → a Closed pill on the business row and the business screen, no
   actions offered on a closed business, and the suspended fleet explained
   instead of unexplained.
2. **`/close`** → the "Stop This Business Trading" card becomes a real closure
   through one address, in one transaction, and the partial-failure path it has
   to carry today goes away.
3. **`PATCH`** → the "These details cannot be edited from the panel yet" line on
   the Business card becomes an edit, through the same reason dialog as
   everything else.

And per this project's rule about drifted documentation: every one of these
addresses must be added to `backendRoutes` in the panel's `lib/playbook.ts`,
which a test checks against what the panel really calls.

---

## Tests to add

In `test/admin.test.ts`, or a new `test/admin-providers.test.ts`:

1. A closed business still appears in `GET /admin/providers`, with `closedAt`
   set; an open one has `closedAt: null`.
2. `POST /admin/providers/:id/close` suspends every vehicle, sets `deleted_at`,
   and writes an audit entry carrying the reason.
3. It is refused with `has_live_rental` while a booking is `active`, and the
   message names the booking reference. Nothing is changed — the cars are still
   live afterwards.
4. It is refused with `already_closed` the second time.
5. Closing with a blank reason is refused before anything is changed.
6. `PATCH /admin/providers/:id` changes one field, writes one audit entry with
   before and after, and refuses `verificationStatus` as an unknown field.
7. If reopen is built: reopening clears `deleted_at`, leaves every car
   suspended, and audits it.

---

## Done means

- `npm run typecheck` and `npm test` pass, on PGlite.
- A business closed from the website shows as closed in the admin panel.
- A staff member can close a business from the panel, with a reason, and the
  closure appears in the audit log against their name.
- Closing is refused, with the server's own sentence naming what is in the way,
  while a rental is running or money is in the air.
- The owner has reviewed it before anything is pushed.
