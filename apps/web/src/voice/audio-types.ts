export type AudioControl =
  | { type: 'input'; epoch: number; enabled: boolean }
  | { type: 'capture_ack'; sequence: number }
  | { type: 'output'; epoch: number }
  | { type: 'pcm'; epoch: number; offset: number; pcm: ArrayBuffer }
  | { type: 'done'; epoch: number; totalSamples: number }
  | { type: 'flush'; epoch: number }
  | { type: 'stop' };

export type AudioObservation =
  | { type: 'capture'; epoch: number; offset: number; sequence: number; pcm: ArrayBuffer }
  | { type: 'played'; epoch: number; samples: number; renderedAt: number }
  | { type: 'meter'; level: number }
  | { type: 'error'; message: string };
