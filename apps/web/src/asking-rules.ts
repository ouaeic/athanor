import type { SecurityMode } from '@athanor/contracts';
// Copied across the client bundle boundary; scripts/check-repository.mjs checks the owning floor.
export const modeFloors: Record<SecurityMode, string> = {
  review:
    'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.',
  balanced:
    'A command reaching an address out on the internet, and installing software onto it, on top of everything Autonomous asks about; the built-in web tools read without asking.',
  autonomous:
    'Works independently. Asks before external commitments, irreversible changes, durable instructions or services, sensitive or unidentified screen actions, and network access it cannot verify after trying an alternative.'
};
