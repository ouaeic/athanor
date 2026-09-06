import type { SecurityMode } from '@athanor/contracts';
// Copied across the client bundle boundary; scripts/check-repository.mjs checks the owning floor.
export const modeFloors: Record<SecurityMode, string> = {
  review:
    'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.',
  balanced:
    'A command reaching an address out on the internet, and installing software onto it, on top of everything Autonomous asks about; the built-in web tools read without asking.',
  autonomous:
    'Only what this computer cannot take back for you — publishing, sending, spending, destroying data, signing or accepting terms in your name, a startup file, hook, schedule, service or tool configuration it would run on its own afterwards, and a control on a screen that nothing could identify.'
};
