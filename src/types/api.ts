// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The exact shapes of information this API hands back to
// the apps. They are copied word for word from types/index.ts in
// sxm-rentals-web (which the admin panel and the phone app share), because
// every screen there is already built to read these shapes. If the API returns
// them unchanged, the apps can swap their sample data for the real thing
// without touching a single screen.
//
// Only the shapes the backend currently returns are copied here. Add more as
// each phase's endpoints are built — and change them only together with the
// web, admin and mobile copies.

// ---- PEOPLE ----
export type AccountType = 'local' | 'tourist';
export type VerificationStatus = 'unstarted' | 'pending' | 'approved' | 'rejected' | 'resubmit';

export type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  accountType: AccountType;
  verification: {
    status: VerificationStatus;
    selfieDone: boolean;
    licenseDone: boolean;
    identityDocDone: boolean; // passport for a tourist, local ID for a resident
    reason?: string; // filled in only when the status is 'rejected'
    submittedAt?: string;
  };
  isIslander: boolean; // a confirmed Sint Maarten / Saint-Martin resident
  memberSince: string;
};

// ---- RENTAL BUSINESSES ----
// PUBLIC information only — everything here appears on the business's page.
export type Provider = {
  id: string;
  businessName: string;
  side: 'dutch' | 'french';
  town: string;
  rating: number;
  reviewCount: number;
  isVerified: boolean;
  respondsIn: string;
  phone: string;
  description: string;
  deliversVehicles: boolean;
  airportPickup: boolean;
  memberSince: string;
};

// ---- VEHICLES ----
export type VehicleType = 'car' | 'atv' | 'boat' | 'bike';
export type VehicleClass = 'economy' | 'compact' | 'suv' | 'van' | 'fourByFour' | 'luxury';
export type Transmission = 'automatic' | 'manual';
export type FuelType = 'petrol' | 'diesel' | 'hybrid' | 'electric';

// Damage the business declared when listing the car. SXM Rentals does not
// independently verify these — the apps always say so.
export type AccidentRecord = {
  date: string;
  description: string;
  repaired: boolean;
};

export type Vehicle = {
  id: string;
  type: VehicleType;
  make: string;
  model: string;
  year: number;
  trim?: string;
  vehicleClass: VehicleClass;
  transmission: Transmission;
  fuel: FuelType;
  seats: number;
  doors: number;
  airConditioning: boolean;
  photos: string[];
  providerId: string;
  dailyRate: number;
  weeklyRate?: number;
  minimumDays: number;
  maximumDays: number;
  depositAmount: number;
  depositIsVehicleSpecific: boolean;
  pickupTown: string;
  side: 'dutch' | 'french';
  deliveryAvailable: boolean;
  // Only on a car that is delivered. 0 means the business delivers for free.
  deliveryFee?: number;
  latitude: number;
  longitude: number;
  rating: number;
  reviewCount: number;
  // True once the business has answered the accident question, even with "none".
  accidentHistoryDeclared: boolean;
  accidentHistory: AccidentRecord[];
  unavailableDates: string[]; // days already booked or taken off sale, as YYYY-MM-DD
  description: string;
};

// ---- REVIEWS ----
export type Review = {
  id: string;
  vehicleId: string;
  authorName: string;
  rating: number;
  date: string;
  body: string;
};

// ---- BOOKINGS ----
export type BookingStatus = 'upcoming' | 'active' | 'completed' | 'cancelled';

// The security deposit has its own life cycle, separate from the rental money.
export type DepositStatus = 'not_taken' | 'held' | 'released' | 'claimed';

export type PriceLine = {
  label: string;
  amount: number;
  note?: string;
};

// A booking as the CUSTOMER sees it.
// A few fields of a car, carried by anything that lists bookings or
// conversations. Null when the car has been taken off the platform since.
export type CarSummary = {
  id: string;
  make: string;
  model: string;
  year: number;
  // The cover photo, or null while the business has not added one.
  photo: string | null;
};

// The rental agreement, as a booking reports it: signed, when, which wording, and
// whether a signature was drawn. The drawing itself is at GET /bookings/:id/agreement.
export type AgreementSummary = { signedAt: string; version: string | null; drawn: boolean };

export type DateChangeView = {
  id: string;
  startDate: string;
  endDate: string;
  fromStartDate: string;
  fromEndDate: string;
  days: number;
  fromDays: number;
  total: number;
  difference: number;
  refund: number;
  explanation: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';
  requestedAt: string;
  decidedAt: string | null;
  note: string | null;
  paymentStatus: 'unpaid' | 'paid' | null;
};

export type Booking = {
  id: string;
  reference: string;
  vehicleId: string;
  providerId: string;
  // Enough of the car and the business to draw a booking card without fetching
  // the whole catalogue first. The ids above stay, so nothing that reads them
  // breaks.
  vehicle: CarSummary | null;
  providerName: string;
  // The latest refund, after a cancellation or a shortened rental.
  refund: { amount: number; status: 'pending' | 'approved' | 'denied'; requestedAt: string; decidedAt: string | null; note: string | null } | null;
  // The latest request to change its dates. See services/date-changes.
  dateChange: DateChangeView | null;
  status: BookingStatus;
  startDate: string;
  endDate: string;
  pickupTime: string;
  returnTime: string;
  collection: 'pickup' | 'delivery';
  location: string;
  // The deposit is deliberately kept out of the rental total so it is never
  // mistaken for something the customer is being charged.
  lines: PriceLine[];
  depositAmount: number;
  depositStatus: DepositStatus;
  totalDueToday: number;
  agreementSigned: boolean;
  // Signed, when, which wording, and whether a signature was drawn.
  agreement: AgreementSummary | null;
  // "authorized" = not paid yet; "paid"; "failed" = the last attempt failed; "refunded".
  paymentStatus: 'paid' | 'authorized' | 'failed' | 'refunded';
  createdAt: string;
};

// A booking as the RENTAL BUSINESS sees it.
// READ THIS BEFORE ADDING A FIELD: there is deliberately no phone number and no
// email address on this type, and there must never be one.
export type ProviderBooking = {
  id: string;
  reference: string;
  vehicleId: string;
  vehicle: CarSummary | null;
  dateChange: (DateChangeView & { grossAmount: number; commission: number; netAmount: number }) | null;
  cancellationReason?: string | null;
  // Signed, when and which version — never the drawing, which is the renter's.
  agreement: AgreementSummary | null;
  status: BookingStatus;
  renterDisplayName: string;
  renterVerified: boolean;
  threadId?: string;
  startDate: string;
  endDate: string;
  pickupTime: string;
  returnTime: string;
  collection: 'pickup' | 'delivery';
  location: string;
  // What the customer paid, what SXM Rentals took, and what the business gets.
  grossAmount: number;
  commission: number;
  netAmount: number;
  // Held against the customer's card and returned to them. Never the business's.
  depositAmount: number;
  depositStatus: DepositStatus;
};
