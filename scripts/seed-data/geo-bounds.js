// scripts/seed-data/geo-bounds.js
// County + city geography for plausible mock lat/lng (SPEC §11). Real-ish
// centroids for NDF's service area; `spreadDeg` is the half-extent of a small
// box drawn around each city centroid so mock homes scatter believably within
// neighborhoods rather than landing on one point. No external lookups.

/**
 * @typedef {Object} City
 * @property {string} name
 * @property {string} county   - 'Stanislaus' | 'San Joaquin' | 'Merced'
 * @property {number} lat
 * @property {number} lng
 * @property {string[]} zips   - representative ZIPs to assign
 * @property {number} weight   - relative share of the ~600 targets
 */

/** @type {City[]} */
export const CITIES = [
  // Stanislaus
  { name: 'Modesto', county: 'Stanislaus', lat: 37.6391, lng: -120.9969, zips: ['95350', '95351', '95355', '95356'], weight: 22 },
  { name: 'Turlock', county: 'Stanislaus', lat: 37.4947, lng: -120.8466, zips: ['95380', '95382'], weight: 9 },
  { name: 'Ceres', county: 'Stanislaus', lat: 37.5949, lng: -120.9577, zips: ['95307'], weight: 6 },
  { name: 'Oakdale', county: 'Stanislaus', lat: 37.7665, lng: -120.8471, zips: ['95361'], weight: 4 },

  // San Joaquin
  { name: 'Stockton', county: 'San Joaquin', lat: 37.9577, lng: -121.2908, zips: ['95202', '95204', '95207', '95209'], weight: 20 },
  { name: 'Manteca', county: 'San Joaquin', lat: 37.7974, lng: -121.2161, zips: ['95336', '95337'], weight: 8 },
  { name: 'Tracy', county: 'San Joaquin', lat: 37.7397, lng: -121.4252, zips: ['95376', '95377'], weight: 7 },
  { name: 'Lodi', county: 'San Joaquin', lat: 38.1302, lng: -121.2724, zips: ['95240', '95242'], weight: 5 },

  // Merced
  { name: 'Merced', county: 'Merced', lat: 37.3022, lng: -120.4830, zips: ['95340', '95341', '95348'], weight: 7 },
  { name: 'Atwater', county: 'Merced', lat: 37.3477, lng: -120.6090, zips: ['95301'], weight: 3 },
  { name: 'Los Banos', county: 'Merced', lat: 37.0583, lng: -120.8499, zips: ['93635'], weight: 3 },
];

/** Half-extent (degrees) of the scatter box around each city centroid (~5km). */
export const SPREAD_DEG = 0.045;

/** Plausible street names for mock addresses. */
export const STREET_NAMES = [
  'Maple Ave', 'Oak St', 'Elm Dr', 'Cedar Ln', 'Pine St', 'Walnut Ave',
  'Sycamore Dr', 'Magnolia St', 'Cypress Way', 'Birch Ct', 'Almond Ave',
  'Orchard Ln', 'Vineyard Dr', 'Sierra Vista', 'Yosemite Blvd', 'Tuolumne Rd',
  'Briggsmore Ave', 'Coffee Rd', 'Standiford Ave', 'McHenry Ave', 'Pelandale Ave',
  'Hammer Ln', 'March Ln', 'Pacific Ave', 'El Dorado St', 'Olive Ave',
  'Geer Rd', 'Monte Vista Ave', 'Lander Ave', 'Bellevue Rd',
];
