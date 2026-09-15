// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The fixed lists of allowed values the database accepts
// — a booking can only be "upcoming", "active", "completed" or "cancelled", a
// car's fuel can only be one of four kinds, and so on. The database itself
// rejects anything not on the list.
//
// These lists mirror types/index.ts and types/admin.ts in sxm-rentals-web and
// sxm-rentals-admin word for word, so the API can hand the apps exactly the
// values their screens already expect. Change a list here only together with
// those files.

import { pgEnum } from 'drizzle-orm/pg-core';

// ---- PEOPLE ----
export const accountType = pgEnum('account_type', ['local', 'tourist']);
export const verificationStatus = pgEnum('verification_status', [
  'unstarted',
  'pending',
  'approved',
  'rejected',
  'resubmit',
]);
export const authTokenPurpose = pgEnum('auth_token_purpose', ['verify_email', 'reset_password']);

// ---- RENTAL BUSINESSES ----
export const islandSide = pgEnum('island_side', ['dutch', 'french']);
export const operatingSide = pgEnum('operating_side', ['dutch', 'french', 'both']);
export const providerMemberRole = pgEnum('provider_member_role', ['owner', 'staff']);
export const registrationStatus = pgEnum('registration_status', ['registered', 'not_registered', 'pending']);
export const payoutAccountStatus = pgEnum('payout_account_status', [
  'not_started',
  'pending',
  'active',
  'restricted',
]);

// ---- VEHICLES ----
export const vehicleType = pgEnum('vehicle_type', ['car', 'atv', 'boat', 'bike']);
export const vehicleClass = pgEnum('vehicle_class', ['economy', 'compact', 'suv', 'van', 'fourByFour', 'luxury']);
export const transmission = pgEnum('transmission', ['automatic', 'manual']);
export const fuelType = pgEnum('fuel_type', ['petrol', 'diesel', 'hybrid', 'electric']);
export const listingStatus = pgEnum('listing_status', ['live', 'pending_review', 'suspended']);
export const vehicleDocumentKind = pgEnum('vehicle_document_kind', ['registration', 'insurance', 'roadworthiness']);
export const documentReviewStatus = pgEnum('document_review_status', ['pending', 'approved', 'rejected']);

// ---- BOOKINGS AND MONEY ----
export const bookingStatus = pgEnum('booking_status', ['upcoming', 'active', 'completed', 'cancelled']);
export const depositStatus = pgEnum('deposit_status', ['not_taken', 'held', 'released', 'claimed']);
export const paymentStatus = pgEnum('payment_status', ['paid', 'authorized', 'refunded', 'failed']);
export const collectionMethod = pgEnum('collection_method', ['pickup', 'delivery']);
export const payoutStatus = pgEnum('payout_status', ['paid', 'pending', 'processing']);
export const ledgerKind = pgEnum('ledger_kind', ['charge', 'refund', 'payout', 'commission']);
export const ledgerStatus = pgEnum('ledger_status', ['succeeded', 'pending', 'failed']);
export const refundStatus = pgEnum('refund_status', ['pending', 'approved', 'denied']);
export const disputeStatus = pgEnum('dispute_status', ['open', 'investigating', 'resolved']);
export const disputeOpenedBy = pgEnum('dispute_opened_by', ['customer', 'provider']);
export const promoKind = pgEnum('promo_kind', ['percent', 'fixed']);
export const promoStatus = pgEnum('promo_status', ['active', 'scheduled', 'paused', 'expired']);
export const promoAudience = pgEnum('promo_audience', ['all', 'local', 'tourist', 'first_booking']);

// ---- MESSAGES, NOTIFICATIONS, REWARDS, SUPPORT ----
export const chatSender = pgEnum('chat_sender', ['customer', 'provider']);
export const notificationKind = pgEnum('notification_kind', [
  'booking_confirmed',
  'payment',
  'pickup_reminder',
  'return_reminder',
  'late_return',
  'cancellation',
  'verification',
  'promotion',
]);
export const supportInteractionStatus = pgEnum('support_interaction_status', [
  'drafted',
  'approved',
  'rejected',
  'sent',
]);

// ---- STAFF AND PLATFORM ----
export const auditAction = pgEnum('audit_action', [
  'account_updated',
  'account_deleted',
  'points_adjusted',
  'verification_approved',
  'verification_rejected',
  'refund_approved',
  'refund_denied',
  'deposit_claimed',
  'deposit_released',
  'promotion_changed',
  'settings_changed',
  'dispute_assigned',
  'dispute_resolved',
]);
export const auditSubjectType = pgEnum('audit_subject_type', [
  'customer',
  'provider',
  'vehicle',
  'booking',
  'payment',
  'platform',
]);
export const kycProvider = pgEnum('kyc_provider', ['stripe_identity', 'persona', 'veriff', 'didit']);
export const payoutEntity = pgEnum('payout_entity', ['us_llc', 'french_side', 'dutch_side']);
