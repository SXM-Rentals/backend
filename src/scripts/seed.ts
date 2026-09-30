// SXM Rentals — Created by Giordano Bertin-Maurice
// Copyright (c) 2026 Giordano Bertin-Maurice. All rights reserved.
// WHAT THIS FILE DOES: The command behind `npm run db:seed`. It fills an EMPTY
// DEVELOPMENT database with a few approved rental businesses, some cars and a
// customer to sign in as, so the website and the phone app have something to
// show while they are being built.
//
// Getting the same thing by hand means signing up, confirming an email, applying
// as a business, creating a staff account, and then approving both the business
// and every listing — which is why the apps were still being built against their
// own made-up data.
//
// IT WILL NOT TOUCH THE LIVE DATABASE. Made-up businesses on a live site are
// worse than an empty one: somebody would try to book a car that does not exist,
// from a company that does not exist. So it refuses when NODE_ENV is production,
// and refuses when DATABASE_URL is set unless --i-know-this-is-not-production is
// passed, because DATABASE_URL is the live Neon address in every setup we have.
//
// Usage:
//   npm run db:seed
//
// Everything it inserts is prefixed SEED so it is obvious in any list, and it
// refuses to run twice over the top of itself.

import { loadConfig } from '../config.js';
import { connectDatabase } from '../db/client.js';
import {
  credentials,
  customers,
  providerBusinessProfiles,
  providerMembers,
  providers,
  vehiclePhotos,
  vehicles,
} from '../db/schema/index.js';
import { hashPassword } from '../lib/passwords.js';
import { eq } from 'drizzle-orm';

const SEED_MARK = 'SEED';
const CUSTOMER_EMAIL = 'seed.customer@sxmrentals.invalid';
const CUSTOMER_PASSWORD = 'a long seeded passphrase';

const config = loadConfig();
const force = process.argv.includes('--i-know-this-is-not-production');

if (config.isProduction) {
  console.error('db:seed refuses to run with NODE_ENV=production. Made-up cars must never appear on the live site.');
  process.exit(1);
}
if (config.databaseUrl && !force) {
  console.error('DATABASE_URL is set, which points at the live Neon database in every setup we have.');
  console.error('Leave it unset to seed the local database in .data/, or, if you are certain this');
  console.error('is a throwaway database, run it again with --i-know-this-is-not-production.');
  process.exit(1);
}

// Real photos of each exact model, openly licensed, from Wikimedia Commons.
// Served through wsrv.nl, a long-running public image cache, because Wikimedia
// refuses Android's own download client (a 403), which left every photo grey on
// an Android phone; wsrv.nl also shrinks them to 1200 pixels across. Position 0
// is the front three-quarter view (search shows it first), 1 the rear.
// DEVELOPMENT ONLY, like the rest of this file: real listings use Cloudinary.
//
// Credits, which the CC BY-SA licences ask to travel with the photos:
//   Kia Picanto   front and rear by Vauxford, CC BY-SA 4.0
//                 commons.wikimedia.org/wiki/File:2017_Kia_Picanto_GT-Line_S_1.2_Front.jpg
//                 commons.wikimedia.org/wiki/File:2017_Kia_Picanto_GT-Line_S_1.2_Rear.jpg
//   Suzuki Jimny  front and rear by TTTNIS, CC0 (no credit needed)
//                 commons.wikimedia.org/wiki/File:2021-2024_Suzuki_Jimny_XL.jpg
//                 commons.wikimedia.org/wiki/File:2021-2024_Suzuki_Jimny_XL_rear.jpg
//   Renault Clio  front and rear by Vauxford, CC BY-SA 4.0
//                 commons.wikimedia.org/wiki/File:2019_Renault_Clio_Iconic_Front.jpg
//                 commons.wikimedia.org/wiki/File:2019_Renault_Clio_Iconic_Rear.jpg
//   Toyota RAV4   front and rear by Kevauto, CC BY-SA 4.0
//                 commons.wikimedia.org/wiki/File:2019_Toyota_RAV4_XLE_AWD,_front_12.31.19.jpg
//                 commons.wikimedia.org/wiki/File:2019_Toyota_RAV4_XLE_AWD,_rear_12.31.19.jpg
const wsrv = (path: string) => `https://wsrv.nl/?url=upload.wikimedia.org%2Fwikipedia%2Fcommons%2Fthumb%2F${path}&w=1200&output=jpg&q=82`;
const PHOTOS: Record<string, [string, string]> = {
  'Kia Picanto': [
    wsrv('b%2Fbe%2F2017_Kia_Picanto_GT-Line_S_1.2_Front.jpg%2F1280px-2017_Kia_Picanto_GT-Line_S_1.2_Front.jpg'),
    wsrv('3%2F39%2F2017_Kia_Picanto_GT-Line_S_1.2_Rear.jpg%2F1280px-2017_Kia_Picanto_GT-Line_S_1.2_Rear.jpg'),
  ],
  'Suzuki Jimny': [
    wsrv('c%2Fc5%2F2021-2024_Suzuki_Jimny_XL.jpg%2F1280px-2021-2024_Suzuki_Jimny_XL.jpg'),
    wsrv('8%2F88%2F2021-2024_Suzuki_Jimny_XL_rear.jpg%2F1280px-2021-2024_Suzuki_Jimny_XL_rear.jpg'),
  ],
  'Renault Clio': [
    wsrv('b%2Fb8%2F2019_Renault_Clio_Iconic_Front.jpg%2F1280px-2019_Renault_Clio_Iconic_Front.jpg'),
    wsrv('a%2Fa4%2F2019_Renault_Clio_Iconic_Rear.jpg%2F1280px-2019_Renault_Clio_Iconic_Rear.jpg'),
  ],
  'Toyota RAV4': [
    wsrv('6%2F6d%2F2019_Toyota_RAV4_XLE_AWD%252C_front_12.31.19.jpg%2F1280px-2019_Toyota_RAV4_XLE_AWD%252C_front_12.31.19.jpg'),
    wsrv('6%2F64%2F2019_Toyota_RAV4_XLE_AWD%252C_rear_12.31.19.jpg%2F1280px-2019_Toyota_RAV4_XLE_AWD%252C_rear_12.31.19.jpg'),
  ],
};

// Two businesses, one on each side of the island, with a couple of cars each.
const BUSINESSES = [
  {
    businessName: `${SEED_MARK} Simpson Bay Auto`,
    town: 'Simpson Bay',
    side: 'dutch' as const,
    latitude: 18.0302,
    longitude: -63.0888,
    description: 'Family run since 1998. Airport pickup, five minutes from the runway.',
    cars: [
      { make: 'Kia', model: 'Picanto', year: 2024, vehicleClass: 'economy' as const, dailyRate: 45, seats: 4, doors: 4 },
      { make: 'Suzuki', model: 'Jimny', year: 2023, vehicleClass: 'fourByFour' as const, dailyRate: 68, seats: 4, doors: 3 },
    ],
  },
  {
    businessName: `${SEED_MARK} Marigot Motors`,
    town: 'Marigot',
    side: 'french' as const,
    latitude: 18.0706,
    longitude: -63.0847,
    description: 'On the French side, by the marina. English and French spoken.',
    cars: [
      { make: 'Renault', model: 'Clio', year: 2024, vehicleClass: 'compact' as const, dailyRate: 52, seats: 5, doors: 5 },
      { make: 'Toyota', model: 'RAV4', year: 2023, vehicleClass: 'suv' as const, dailyRate: 89, seats: 5, doors: 5 },
    ],
  },
];

const connection = await connectDatabase(config.databaseUrl);

try {
  const existing = await connection.db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.businessName, BUSINESSES[0]!.businessName))
    .limit(1);
  if (existing.length > 0) {
    console.log('Already seeded — nothing to do. Delete the .data folder to start over.');
    process.exit(0);
  }

  let carCount = 0;
  for (const business of BUSINESSES) {
    const [provider] = await connection.db
      .insert(providers)
      .values({
        businessName: business.businessName,
        side: business.side,
        town: business.town,
        description: business.description,
        phone: '+1 721 555 0100',
        respondsIn: 'within_hour',
        deliversVehicles: true,
        airportPickup: business.side === 'dutch',
        // Approved, because an unapproved business is invisible to customers —
        // which is correct, and useless for looking at a catalogue.
        isVerified: true,
        verificationStatus: 'approved',
        rating: 4.7,
        reviewCount: 23,
      })
      .returning();

    await connection.db.insert(providerBusinessProfiles).values({
      providerId: provider!.id,
      legalName: `${business.businessName} N.V.`,
      contactEmail: 'seed.business@sxmrentals.invalid',
      ownerName: 'Seeded Owner',
      ownerPhone: '+1 721 555 0101',
      operatingSide: business.side,
      fleetSizeBand: '1-5',
      locations: [business.town],
    });

    for (const car of business.cars) {
      carCount += 1;
      const [vehicle] = await connection.db
        .insert(vehicles)
        .values({
          reference: `SXM-SEED-${100 + carCount}`,
          providerId: provider!.id,
          make: car.make,
          model: car.model,
          year: car.year,
          vehicleClass: car.vehicleClass,
          transmission: 'automatic',
          fuel: 'petrol',
          seats: car.seats,
          doors: car.doors,
          dailyRateCents: car.dailyRate * 100,
          weeklyRateCents: car.dailyRate * 100 * 6,
          depositAmountCents: 50_000,
          depositIsVehicleSpecific: true,
          pickupTown: business.town,
          side: business.side,
          latitude: business.latitude,
          longitude: business.longitude,
          deliveryAvailable: true,
          airConditioning: true,
          description: `${car.make} ${car.model}, ${car.year}. Seeded for development.`,
          // Approved, so it appears in search.
          listingStatus: 'live',
          rating: 4.6,
          reviewCount: 8,
        })
        .returning();

      // Two photos of the model itself — see PHOTOS above for where they are from.
      const [front, rear] = PHOTOS[`${car.make} ${car.model}`]!;
      await connection.db.insert(vehiclePhotos).values([
        { vehicleId: vehicle!.id, storageKey: front, position: 0 },
        { vehicleId: vehicle!.id, storageKey: rear, position: 1 },
      ]);
    }
  }

  // Somebody to sign in as, already confirmed so sign-in works without an email
  // having to arrive.
  const [customer] = await connection.db
    .insert(customers)
    .values({
      firstName: 'Seeded',
      lastName: 'Customer',
      email: CUSTOMER_EMAIL,
      phone: '+1 721 555 0199',
      accountType: 'tourist',
      verificationStatus: 'approved',
    })
    .returning();
  await connection.db.insert(credentials).values({
    customerId: customer!.id,
    passwordHash: await hashPassword(CUSTOMER_PASSWORD),
    emailVerifiedAt: new Date(),
  });
  // Not a member of either business: the seeded customer is a renter, and a
  // business owner is a separate thing to set up deliberately.
  await connection.db.delete(providerMembers).where(eq(providerMembers.customerId, customer!.id));

  console.log(`Seeded ${BUSINESSES.length} businesses and ${carCount} cars, all approved and visible.`);
  console.log('');
  console.log('Sign in as:');
  console.log(`  email:    ${CUSTOMER_EMAIL}`);
  console.log(`  password: ${CUSTOMER_PASSWORD}`);
  console.log('');
  console.log('Everything inserted is named SEED, so it is obvious in any list.');
} catch (error) {
  console.error(`Could not seed the database: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await connection.close();
}
