import { describe, expect, it } from 'vitest';
import {
  attachmentDisplayName,
  attachmentPath,
  attachmentTrailer,
  fileKindLabel,
  imageMimeType,
  inlineMediaKind,
  isImageAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  planUploads,
  voiceNoteExtension,
  safeAttachmentName,
  splitAttachments,
  withAttachments
} from './attachments.js';

describe('attachment naming', () => {
  it('keeps a name the agent can quote, and keeps the extension', () => {
    expect(safeAttachmentName('Q3 report (final).pdf')).toBe('Q3-report-final-.pdf');
    expect(safeAttachmentName('  ../../etc/passwd')).toBe('etc-passwd');
    expect(safeAttachmentName('...')).toBe('attachment');
    expect(safeAttachmentName(`${'a'.repeat(200)}.csv`)).toHaveLength(120);
    expect(safeAttachmentName(`${'a'.repeat(200)}.csv`).endsWith('.csv')).toBe(true);
  });

  it('places the upload under the uploads root with its own id', () => {
    expect(attachmentPath('photo.png', '11111111-2222-4333-8444-555555555555')).toBe(
      'workspace/uploads/11111111-2222-4333-8444-555555555555-photo.png'
    );
  });

  it('shows the chosen name rather than the id that made it unique', () => {
    expect(
      attachmentDisplayName('workspace/uploads/11111111-2222-4333-8444-555555555555-photo.png')
    ).toBe('photo.png');
    expect(attachmentDisplayName('workspace/imports/notes/todo.md')).toBe('todo.md');
  });

  it('recognises images and types them for the browser', () => {
    expect(isImageAttachment('workspace/uploads/a-photo.JPG')).toBe(true);
    expect(isImageAttachment('workspace/uploads/a-invoice.pdf')).toBe(false);
    expect(imageMimeType('workspace/uploads/a-photo.JPG')).toBe('image/jpeg');
    expect(imageMimeType('workspace/uploads/a-invoice.pdf')).toBe('application/octet-stream');
  });
});

describe('naming a produced file', () => {
  it('calls the office formats what the owner asked for', () => {
    expect(
      fileKindLabel(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'board-q3.pptx'
      )
    ).toBe('Presentation');
    expect(
      fileKindLabel(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'cv.docx'
      )
    ).toBe('Word document');
    expect(
      fileKindLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'q3.xlsx')
    ).toBe('Spreadsheet');
    expect(fileKindLabel('application/pdf', 'contract.pdf')).toBe('PDF');
  });

  it('falls back to the family, then to the extension, then to something honest', () => {
    expect(fileKindLabel('image/png', 'logo.png')).toBe('Image');
    expect(fileKindLabel('video/mp4', 'clip.mp4')).toBe('Video');
    expect(fileKindLabel('audio/mpeg', 'voice.mp3')).toBe('Audio');
    expect(fileKindLabel('text/plain', 'notes.txt')).toBe('Text file');
    expect(fileKindLabel('application/octet-stream', 'model.safetensors')).toBe('SAFETENSORS file');
    expect(fileKindLabel('application/octet-stream', 'noextension')).toBe('File');
    expect(fileKindLabel('')).toBe('File');
  });

  it('ignores parameters and case on the media type', () => {
    expect(fileKindLabel('text/CSV; charset=utf-8', 'rows.csv')).toBe('CSV');
  });
});

describe('attachments on a message', () => {
  it('attaches paths after the message instead of inside it', () => {
    const message = withAttachments('Have a look at this invoice.', [
      'workspace/uploads/a-invoice.pdf'
    ]);
    expect(message).toBe(
      'Have a look at this invoice.\n\nAttached files:\n- workspace/uploads/a-invoice.pdf'
    );
    expect(splitAttachments(message)).toEqual({
      body: 'Have a look at this invoice.',
      paths: ['workspace/uploads/a-invoice.pdf']
    });
  });

  it('round-trips a message that is only attachments', () => {
    const message = withAttachments('', ['workspace/uploads/a-photo.png']);
    expect(splitAttachments(message)).toEqual({
      body: '',
      paths: ['workspace/uploads/a-photo.png']
    });
  });

  it('leaves a message with no attachments exactly as written', () => {
    expect(attachmentTrailer([])).toBe('');
    expect(withAttachments('Just a question', [])).toBe('Just a question');
    expect(splitAttachments('Just a question')).toEqual({ body: 'Just a question', paths: [] });
  });

  it('does not turn prose about attachments into a file strip', () => {
    const prose = 'Attached files:\nare not something I have sent you yet.';
    expect(splitAttachments(prose)).toEqual({ body: prose, paths: [] });

    const trailing = 'Look at this.\n\nAttached files:\n- workspace/uploads/a.pdf\n\nAlso, thanks.';
    expect(splitAttachments(trailing)).toEqual({ body: trailing, paths: [] });

    const outsideRoot = 'Look.\n\nAttached files:\n- /etc/passwd';
    expect(splitAttachments(outsideRoot)).toEqual({ body: outsideRoot, paths: [] });
  });

  it('keeps every attachment when several were sent together', () => {
    const message = withAttachments('Three things', [
      'workspace/uploads/a-one.pdf',
      'workspace/uploads/b-two.png',
      'workspace/imports/site/three.csv'
    ]);
    expect(splitAttachments(message).paths).toEqual([
      'workspace/uploads/a-one.pdf',
      'workspace/uploads/b-two.png',
      'workspace/imports/site/three.csv'
    ]);
  });
});

describe('which files the composer will actually upload', () => {
  const file = (name: string, size: number) => ({ name, size });

  it('takes everything within the limit and says nothing', () => {
    const { accepted, message } = planUploads([file('a.pdf', 10), file('b.png', 20)]);
    expect(accepted.map((item) => item.name)).toEqual(['a.pdf', 'b.png']);
    expect(message).toBe('');
  });

  it('names the file that is too big and where to put it instead', () => {
    const { accepted, message } = planUploads([
      file('small.pdf', 10),
      file('huge.mov', MAX_ATTACHMENT_BYTES + 1)
    ]);
    expect(accepted.map((item) => item.name)).toEqual(['small.pdf']);
    expect(message).toContain('huge.mov');
    expect(message).toContain('49 MiB');
    expect(message).toContain('Files pane');
  });

  it('reads as one file or several', () => {
    const one = planUploads([file('a.mov', MAX_ATTACHMENT_BYTES + 1)]).message;
    const two = planUploads([
      file('a.mov', MAX_ATTACHMENT_BYTES + 1),
      file('b.mov', MAX_ATTACHMENT_BYTES + 1)
    ]).message;
    expect(one).toContain('is over');
    expect(two).toContain('are over');
  });

  /*
   * The count used to be applied before the size check, so twenty files too big to send took the
   * whole allowance with them and the twenty-first, which was fine, vanished with no message.
   */
  it('spends the allowance on files that can actually be sent', () => {
    const oversized = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) =>
      file(`big-${index}.mov`, MAX_ATTACHMENT_BYTES + 1)
    );
    const { accepted } = planUploads([...oversized, file('report.pdf', 10)]);
    expect(accepted.map((item) => item.name)).toEqual(['report.pdf']);
  });

  it('says how many were left out rather than dropping them in silence', () => {
    const many = Array.from({ length: MAX_ATTACHMENT_COUNT + 3 }, (_, index) =>
      file(`f-${index}.txt`, 10)
    );
    const { accepted, message } = planUploads(many);
    expect(accepted).toHaveLength(MAX_ATTACHMENT_COUNT);
    expect(message).toContain('3 were left out');
  });

  it('ignores an empty file, which is what a dropped folder produces', () => {
    const { accepted, message } = planUploads([file('folder', 0), file('a.pdf', 5)]);
    expect(accepted.map((item) => item.name)).toEqual(['a.pdf']);
    expect(message).toBe('');
  });
});

describe('sending a voice note for transcription', () => {
  /* The route reads the container from the extension rather than sniffing the bytes, and the
     browser picks the container: Safari records mp4, everything else records webm. */
  it('names the container the browser actually recorded', () => {
    expect(voiceNoteExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(voiceNoteExtension('audio/mp4')).toBe('m4a');
    expect(voiceNoteExtension('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(voiceNoteExtension('audio/ogg;codecs=opus')).toBe('ogg');
  });

  it('sends the common case rather than nothing when the browser says something unexpected', () => {
    expect(voiceNoteExtension('')).toBe('webm');
    expect(voiceNoteExtension('audio/x-unknown')).toBe('webm');
  });

  it('does not care how the browser cased it', () => {
    expect(voiceNoteExtension('AUDIO/MP4')).toBe('m4a');
  });
});

/*
 * The card in the transcript drew an `<img>` around anything whose type began `image/`, and the
 * route it pointed at answers `application/octet-stream` with `content-disposition: attachment` for
 * everything outside its own allowlist - because the type on an artifact is a free-form string the
 * agent supplied, and a page it read may have chosen that string. A photo published from a phone as
 * `image/heic`, or a chart saved as SVG, arrived as a broken image frame in the conversation.
 */
describe('which produced files the transcript can show inline', () => {
  it('gives each family the element it plays in', () => {
    expect(inlineMediaKind('image/png')).toBe('image');
    expect(inlineMediaKind('audio/mpeg')).toBe('audio');
    expect(inlineMediaKind('video/mp4')).toBe('video');
  });

  it('does not draw a frame around bytes the route will hand back as a download', () => {
    // Both are `image/*`; neither is on the serving route's inline allowlist.
    expect(inlineMediaKind('image/svg+xml')).toBeUndefined();
    expect(inlineMediaKind('image/heic')).toBeUndefined();
  });

  it('leaves the files that are opened rather than played to the card', () => {
    expect(inlineMediaKind('application/pdf')).toBeUndefined();
    expect(inlineMediaKind('text/plain')).toBeUndefined();
    expect(inlineMediaKind('application/octet-stream')).toBeUndefined();
  });

  it('reads the type the way the server does, parameters and casing included', () => {
    expect(inlineMediaKind('IMAGE/PNG')).toBe('image');
    expect(inlineMediaKind('audio/mp4; codecs="mp4a.40.2"')).toBe('audio');
    expect(inlineMediaKind('')).toBeUndefined();
  });
});
