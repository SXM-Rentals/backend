// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Turns the database rows for a car, a rental business and
// a review into the exact shapes the website and phone app already draw their
// screens from. Money is stored in cents and handed out in dollars.
//
// Each field is copied across by name. Anything else on the row — staff notes,
// internal flags, whatever a later phase adds — cannot leak into a public
// response just because it happens to sit on the same record.

import type { providers, reviews, vehicleAccidentRecords, vehiclePhotos, vehicles } from '../../db/schema/index.js';
import type { Provider, Review, Vehicle } from '../../types/api.js';
import { renterDisplayName } from './bookings.js';

type VehicleRow = typeof vehicles.$inferSelect;
type PhotoRow = typeof vehiclePhotos.$inferSelect;
type AccidentRow = typeof vehicleAccidentRecords.$inferSelect;
type ProviderRow = typeof providers.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;

const toAmount = (cents: number) => cents / 100;

// ---- A CAR, AS A CUSTOMER SEES IT ----
export function toVehicle(
  vehicle: VehicleRow,
  photos: PhotoRow[],
  accidents: AccidentRow[],
  unavailableDates: string[],
): Vehicle {
  return {
    id: vehicle.id,
    type: vehicle.type,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    ...(vehicle.trim ? { trim: vehicle.trim } : {}),
    vehicleClass: vehicle.vehicleClass,
    transmission: vehicle.transmission,
    fuel: vehicle.fuel,
    seats: vehicle.seats,
    doors: vehicle.doors,
    airConditioning: vehicle.airConditioning,
    photos: [...photos].sort((a, b) => a.position - b.position).map((photo) => photo.storageKey),
    providerId: vehicle.providerId,
    dailyRate: toAmount(vehicle.dailyRateCents),
    ...(vehicle.weeklyRateCents ? { weeklyRate: toAmount(vehicle.weeklyRateCents) } : {}),
    minimumDays: vehicle.minimumDays,
    maximumDays: vehicle.maximumDays,
    // The deposit a customer should expect to have held. Never part of a price.
    depositAmount: toAmount(vehicle.depositAmountCents),
    depositIsVehicleSpecific: vehicle.depositIsVehicleSpecific,
    pickupTown: vehicle.pickupTown,
    side: vehicle.side,
    deliveryAvailable: vehicle.deliveryAvailable,
    ...(vehicle.deliveryFeeCents ? { deliveryFee: toAmount(vehicle.deliveryFeeCents) } : {}),
    latitude: vehicle.latitude,
    longitude: vehicle.longitude,
    rating: vehicle.rating,
    reviewCount: vehicle.reviewCount,
    accidentHistory: [...accidents]
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn))
      .map((accident) => ({
        date: accident.occurredOn,
        description: accident.description,
        repaired: accident.repaired,
      })),
    unavailableDates,
    description: vehicle.description,
  };
}

// ---- A RENTAL BUSINESS'S PUBLIC PAGE ----
// The private half of the record (legal name, the owner's own mobile,
// registration) lives in another table and is deliberately not read here.
export function toProvider(provider: ProviderRow): Provider {
  return {
    id: provider.id,
    businessName: provider.businessName,
    side: provider.side,
    town: provider.town,
    rating: provider.rating,
    reviewCount: provider.reviewCount,
    isVerified: provider.isVerified,
    respondsIn: provider.respondsIn,
    phone: provider.phone,
    description: provider.description,
    deliversVehicles: provider.deliversVehicles,
    airportPickup: provider.airportPickup,
    memberSince: provider.createdAt.toISOString(),
  };
}

// ---- A REVIEW ----
// Reviews are public, so the writer is shown the same way a business sees a
// renter: a first name and an initial, never a full name or any contact detail.
export function toReview(review: ReviewRow, author: { firstName: string; lastName: string }): Review {
  return {
    id: review.id,
    vehicleId: review.vehicleId,
    authorName: renterDisplayName(author.firstName, author.lastName),
    rating: review.rating,
    date: review.createdAt.toISOString(),
    body: review.body,
  };
}
