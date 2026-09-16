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
  deliveryFee?: number;
  latitude: number;
  longitude: number;
  rating: number;
  reviewCount: number;
  accidentHistory: AccidentRecord[];
  unavailableDates: string[]; // days already booked, as YYYY-MM-DD
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
export type Booking = {
  id: string;
  reference: string;
  vehicleId: string;
  providerId: string;
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
  createdAt: string;
};

// A booking as the RENTAL BUSINESS sees it.
// READ THIS BEFORE ADDING A FIELD: there is deliberately no phone number and no
// email address on this type, and there must never be one.
export type ProviderBooking = {
  id: string;
  reference: string;
  vehicleId: string;
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
