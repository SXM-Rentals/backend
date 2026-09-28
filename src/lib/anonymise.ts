// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Works out what is left of a person's details once they
// close their account — what goes, and the little that has to stay.
//
// WHY ANYTHING STAYS AT ALL: past rentals and the payments to businesses have to
// keep adding up. A booking points at this row, an invoice was issued against it,
// and a payout to a rental business was calculated from it. Erasing the row
// outright would leave money in the books belonging to nobody.
//
// WHY MOST OF IT GOES: Apple (guideline 5.1.1(v)) and Google Play both expect
// closing an account to remove the personal details that are not needed for
// legal or financial records, and it is the right thing regardless of what a
// store requires. The phone number is not needed for any of that, and a full
// surname is not needed once the first name and an initial identify the renter on
// a receipt — which is all a rental business was ever shown anyway.
//
// AND THE EMAIL ADDRESS IS FREED. It is unique across every account, open or
// closed, so leaving it in place meant the same person could never sign up again:
// sign-up quietly answered "you already have an account" for an account they had
// closed themselves, for ever.

// The replacement address. The ".invalid" ending is reserved by the internet's
// own standards (RFC 2606) and can never be a real domain, so nothing can ever
// be delivered to it and nobody can claim it. Lower-case, because the customers
// table checks that every address is.
export function closedAccountEmail(customerId: string): string {
  return `closed-${customerId}@accounts.sxmrentals.invalid`.toLowerCase();
}

// What the row becomes. Given "Benjamin", "Jones" it keeps "Benjamin J." — the
// same name the business saw while the rental was live, and enough for whoever
// reads a receipt next year to recognise the person who paid.
export function anonymisedCustomer(input: { id: string; lastName: string }): {
  email: string;
  phone: null;
  lastName: string;
} {
  const initial = input.lastName.trim().charAt(0).toUpperCase();
  return {
    email: closedAccountEmail(input.id),
    phone: null,
    lastName: initial ? `${initial}.` : '',
  };
}
