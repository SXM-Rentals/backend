// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: Turns conversation rows into the two views the apps
// draw: the CUSTOMER'S (who they are talking to, which business) and the
// RENTAL BUSINESS'S (who is asking, and whether they have been verified).
//
// THE PRIVACY RULE, AGAIN. The business's view is built field by field from a
// renter summary that has no phone number and no email address on it, so a
// business talking to a customer inside SXM Rentals can never be handed their
// contact details — exactly as with bookings. There is a test for it.
//
// "from" is written from the CUSTOMER's point of view, matching the apps:
// 'customer' means the renter wrote it, 'provider' means the business did. The
// business screens flip that round when drawing the bubbles.

import type { chatMessages, chatThreads } from '../../db/schema/index.js';
import type { VerificationStatus } from '../../types/api.js';
import { renterDisplayName } from './bookings.js';

type ThreadRow = typeof chatThreads.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

// What a business is allowed to know about the person they are talking to.
// DO NOT add contact details here.
export type RenterSummary = {
  firstName: string;
  lastName: string;
  verificationStatus: VerificationStatus;
};

export function toChatMessage(message: MessageRow) {
  return {
    id: message.id,
    from: message.sender,
    body: message.body,
    sentAt: message.sentAt.toISOString(),
    read: message.readAt !== null,
    // A car attached to the message, shown as a small card in the bubble.
    ...(message.vehicleId ? { vehicleId: message.vehicleId } : {}),
  };
}

const byTime = (a: MessageRow, b: MessageRow) => a.sentAt.getTime() - b.sentAt.getTime();

// ---- THE CUSTOMER'S VIEW ----
// Unread means messages the BUSINESS sent that the customer has not read.
export function toChatThread(thread: ThreadRow, messages: MessageRow[], bookingRef?: string) {
  return {
    id: thread.id,
    providerId: thread.providerId,
    ...(bookingRef ? { bookingRef } : {}),
    messages: [...messages].sort(byTime).map(toChatMessage),
    unreadCount: messages.filter((message) => message.sender === 'provider' && message.readAt === null).length,
  };
}

// ---- THE RENTAL BUSINESS'S VIEW ----
// Unread means messages the CUSTOMER sent that the business has not read.
export function toBusinessChatThread(
  thread: ThreadRow,
  messages: MessageRow[],
  renter: RenterSummary,
  bookingRef?: string,
) {
  return {
    id: thread.id,
    renterDisplayName: renterDisplayName(renter.firstName, renter.lastName),
    renterVerified: renter.verificationStatus === 'approved',
    ...(bookingRef ? { bookingRef } : {}),
    ...(thread.vehicleId ? { vehicleId: thread.vehicleId } : {}),
    messages: [...messages].sort(byTime).map(toChatMessage),
    unreadCount: messages.filter((message) => message.sender === 'customer' && message.readAt === null).length,
  };
}
