export interface UsageReservationInput {
  availableIncluded: number;
  availableOverage: number;
  estimate: number;
  hardMaximum: number;
}

export interface UsageReservation {
  allowed: boolean;
  reserved: number;
  included: number;
  overage: number;
  reason?: string;
}

export const storageThreshold = (used: number, limit: number): 0 | 70 | 85 | 95 | 100 => {
  if (limit <= 0) return 100;
  const percentage = (used / limit) * 100;
  if (percentage >= 100) return 100;
  if (percentage >= 95) return 95;
  if (percentage >= 85) return 85;
  if (percentage >= 70) return 70;
  return 0;
};
