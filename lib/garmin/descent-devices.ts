import "server-only";

export type GarminDeviceInfo = {
  manufacturer?: number;
  product?: number;
  garminProduct?: number;
  softwareVersion?: number;
};

// Based on FIT SDK Profile.xlsx
// Manufacturer ID for Garmin is 1.
export const GARMIN_MANUFACTURER_ID = 1;

// Known Descent product IDs (this may need updating as new devices are released)
// Product IDs:
// Descent Mk1: 2859
// Descent Mk2 / Mk2i: 3542
// Descent Mk2s: 3737
// Descent G1: 3930
// Descent Mk3 / Mk3i: 4363, 4426
const DESCENT_PRODUCT_IDS = new Set([
  2859, // Mk1
  3542, // Mk2/Mk2i
  3737, // Mk2s
  3930, // G1
  4363, // Mk3
  4426, // Mk3i
]);

export function isDescentDevice(info: GarminDeviceInfo): boolean {
  if (info.manufacturer !== GARMIN_MANUFACTURER_ID) {
    return false;
  }
  
  // Checking either product or garminProduct field
  if (info.product && DESCENT_PRODUCT_IDS.has(info.product)) {
    return true;
  }
  if (info.garminProduct && DESCENT_PRODUCT_IDS.has(info.garminProduct)) {
    return true;
  }
  
  return false;
}
