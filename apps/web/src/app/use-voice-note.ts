import { useRef, useState } from 'react';
import { api } from '../api.js';
import { voiceNoteExtension } from '../attachments.js';
import { describeFailure } from '../failure-text.js';
import type { Workspace } from '../types.js';

/**
 * Dictation into the message box: the recorder, the bytes it has collected, and the one flag the
 * interface reads.
 *
 * The transcript is appended to whatever is already typed rather than replacing it, because a voice
 * note is usually the second half of a sentence somebody started with their hands.
 */
export const useVoiceNote = (input: {
  workspace: Workspace | undefined;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) => {
  const { workspace, onTranscript, onError, onBusy } = input;
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const chunks = useRef<Blob[]>([]);

  const toggle = async () => {
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
      return;
    }
    if (!workspace || !navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in window)) {
      onError('Voice capture is not available on this device');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      const next = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunks.current = [];
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      next.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        recorder.current = undefined;
        const type = next.mimeType || 'audio/webm';
        const extension = voiceNoteExtension(type);
        const voice = new Blob(chunks.current, { type });
        chunks.current = [];
        onBusy(true);
        onError('');
        void api
          .transcribeAudio(new Uint8Array(await voice.arrayBuffer()), extension)
          .then(({ text }) => onTranscript(text))
          .catch((cause) => {
            onError(describeFailure(cause, 'Could not transcribe this voice note'));
          })
          .finally(() => onBusy(false));
      };
      next.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        recorder.current = undefined;
        onError('Voice recording stopped unexpectedly');
      };
      recorder.current = next;
      next.start(1_000);
      setRecording(true);
    } catch (cause) {
      onError(describeFailure(cause, 'Microphone permission was not granted'));
    }
  };

  return { recording, toggle };
};
