/** The frame is opaque and scriptless; its own policy also forbids remote assets and form actions. */
export const shareArtifactDocument = (html: string): string =>
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: data:; " +
  "font-src data:; form-action 'none'; base-uri 'none'" +
  '">' +
  html;
