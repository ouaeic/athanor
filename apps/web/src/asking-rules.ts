import type { SecurityMode } from '@athanor/contracts';
// Copied across the client bundle boundary; scripts/check-repository.mjs checks the owning floor.
export const modeFloors: Record<SecurityMode, string> = {
  review:
    'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.',
  balanced:
    'A command reaching an address out on the internet, and installing software onto it, on top of everything Autonomous asks about; the built-in web tools read without asking.',
  autonomous:
    'Works independently. Asks before publishing, sending, spending, destroying data, signing or accepting terms in your name, a durable instruction, schedule, service or tool configuration, private input, an unidentified screen action, or network access it still cannot verify after trying an alternative.'
};
