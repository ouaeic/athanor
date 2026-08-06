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

export const reserveUsage = (input: UsageReservationInput): UsageReservation => {
  if (!Number.isFinite(input.estimate) || input.estimate <= 0) {
    return { allowed: false, reserved: 0, included: 0, overage: 0, reason: 'Invalid estimate' };
  }
  if (input.estimate > input.hardMaximum) {
    return {
      allowed: false,
      reserved: 0,
      included: 0,
      overage: 0,
      reason: 'Estimate exceeds the task maximum'
    };
  }
  const included = Math.min(input.availableIncluded, input.estimate);
  const overage = Math.max(0, input.estimate - included);
  if (overage > input.availableOverage) {
    return {
      allowed: false,
      reserved: 0,
      included: 0,
      overage: 0,
      reason: 'Insufficient compute balance and overage allowance'
    };
  }
  return { allowed: true, reserved: input.estimate, included, overage };
};

export const storageThreshold = (used: number, limit: number): 0 | 70 | 85 | 95 | 100 => {
  if (limit <= 0) return 100;
  const percentage = (used / limit) * 100;
  if (percentage >= 100) return 100;
  if (percentage >= 95) return 95;
  if (percentage >= 85) return 85;
  if (percentage >= 70) return 70;
  return 0;
};
