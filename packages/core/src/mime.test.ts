import { describe, expect, it } from 'vitest';
import {
  composeMessage,
  decodeEncodedWords,
  extractPart,
  htmlToText,
  parseAddressList,
  parseMessage
} from './mime.js';

const crlf = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'binary');

const multipartMessage = crlf([
  'From: "Ada, Lovelace" <ada@example.test>',
  'To: owner@example.test, Charles Babbage <charles@example.test>',
  'Cc: (a comment) grace@example.test',
  `Subject: =?utf-8?B?${Buffer.from('Holà café', 'utf8').toString('base64')}?= =?utf-8?Q?_r=C3=A9union?=`,
  'Date: Tue, 14 Jul 2026 09:30:00 +0000',
  'Message-ID: <first@example.test>',
  'References: <root@example.test> <second@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: text/plain; charset=iso-8859-1',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Caf=E9 at nine.=',
  'Bring the report.',
  '',
  '--outer',
  'Content-Type: application/pdf',
  "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf",
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.7 tiny').toString('base64'),
  '',
  '--outer--',
  ''
]);

describe('mime reading', () => {
  it('decodes headers, addresses and a quoted-printable body across charsets', () => {
    const parsed = parseMessage(multipartMessage);
    expect(parsed.subject).toBe('Holà café réunion');
    expect(parsed.from).toEqual([{ name: 'Ada, Lovelace', address: 'ada@example.test' }]);
    expect(parsed.to).toEqual([
      { name: null, address: 'owner@example.test' },
      { name: 'Charles Babbage', address: 'charles@example.test' }
    ]);
    expect(parsed.cc).toEqual([{ name: null, address: 'grace@example.test' }]);
    expect(parsed.references).toEqual(['<root@example.test>', '<second@example.test>']);
    expect(parsed.date).toBe('2026-07-14T09:30:00.000Z');
    expect(parsed.text).toBe('Café at nine.Bring the report.');
    expect(parsed.textFromHtml).toBe(false);
  });

  it('inventories attachments with an RFC 2231 filename and hands the bytes back by part id', () => {
    const parsed = parseMessage(multipartMessage);
    expect(parsed.attachments).toEqual([
      {
        partId: '1.2',
        filename: 'résumé.pdf',
        contentType: 'application/pdf',
        size: 13,
        inline: false
      }
    ]);
    const part = extractPart(multipartMessage, '1.2');
    expect(part?.content.toString('utf8')).toBe('%PDF-1.7 tiny');
    expect(extractPart(multipartMessage, '1.9')).toBeNull();
  });

  it('takes one branch of an alternative and falls back to readable text from HTML only', () => {
    const alternative = crlf([
      'Subject: Update',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The plain one.',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>The rich one.</p>',
      '--alt--',
      ''
    ]);
    expect(parseMessage(alternative).text).toBe('The plain one.');

    const htmlOnly = crlf([
      'Subject: Update',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<style>p{color:red}</style><p>Hello <b>there</b></p><ul><li>one</li><li>two</li></ul>',
      ''
    ]);
    const parsed = parseMessage(htmlOnly);
    expect(parsed.textFromHtml).toBe(true);
    expect(parsed.text).toBe('Hello there\n\n- one\n- two');
  });

  it('bounds the body it returns and says so', () => {
    const long = crlf(['Subject: Long', '', 'x'.repeat(5000), '']);
    const parsed = parseMessage(long, { maxTextCharacters: 500 });
    expect(parsed.text).toHaveLength(500);
    expect(parsed.textTruncated).toBe(true);
  });

  it('survives malformed input without throwing', () => {
    expect(parseMessage(Buffer.from('not a message at all')).subject).toBe('');
    expect(
      parseMessage(Buffer.from('Content-Type: multipart/mixed; boundary="x"\r\n\r\nno parts here'))
        .attachments
    ).toEqual([]);
    expect(parseAddressList('Group: one@example.test, two@example.test;')).toEqual([
      { name: null, address: 'one@example.test' },
      { name: null, address: 'two@example.test' }
    ]);
    expect(parseAddressList('broken <no-at-sign>')).toEqual([]);
    expect(decodeEncodedWords('=?unknown-charset?B?aGk=?=')).toBe('hi');
    expect(htmlToText('<script>alert(1)</script><p>safe</p>')).toBe('safe');
  });
});

describe('mime writing', () => {
  const from = { name: 'Owner', address: 'owner@example.test' };

  it('round-trips a plain message through its own parser', () => {
    const { raw, messageId } = composeMessage({
      from,
      to: [{ name: 'Ada', address: 'ada@example.test' }],
      cc: [],
      bcc: [{ name: null, address: 'hidden@example.test' }],
      subject: 'Café tomorrow',
      text: 'Line one\nLine two',
      date: new Date('2026-07-14T09:30:00Z')
    });
    const parsed = parseMessage(raw);
    expect(parsed.subject).toBe('Café tomorrow');
    expect(parsed.text).toBe('Line one\r\nLine two');
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.to).toEqual([{ name: 'Ada', address: 'ada@example.test' }]);
    // A blind copy is an envelope fact; writing it into the message is how it stops being blind.
    expect(raw.toString('utf8')).not.toContain('hidden@example.test');
    expect(raw.toString('utf8')).toContain('Date: Tue, 14 Jul 2026 09:30:00 +0000');
  });

  it('writes attachments as their own parts and reads them back', () => {
    const { raw } = composeMessage({
      from,
      to: [{ name: null, address: 'ada@example.test' }],
      cc: [],
      bcc: [],
      subject: 'Report',
      text: 'Attached.',
      attachments: [
        {
          filename: 'rapport final.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('%PDF-1.7 body')
        }
      ]
    });
    const parsed = parseMessage(raw);
    expect(parsed.text).toBe('Attached.');
    expect(parsed.attachments[0]?.filename).toBe('rapport final.pdf');
    expect(extractPart(raw, parsed.attachments[0]!.partId)?.content.toString('utf8')).toBe(
      '%PDF-1.7 body'
    );
  });

  it('refuses a header value that would inject a second header, and a bad address', () => {
    expect(() =>
      composeMessage({
        from,
        to: [{ name: null, address: 'ada@example.test' }],
        cc: [],
        bcc: [],
        subject: 'Hello\r\nBcc: attacker@example.test',
        text: 'x'
      })
    ).toThrow('line break');
    expect(() =>
      composeMessage({
        from,
        to: [{ name: 'Trouble\nBcc: attacker@example.test', address: 'ada@example.test' }],
        cc: [],
        bcc: [],
        subject: 'Hello',
        text: 'x'
      })
    ).toThrow('line break');
    expect(() =>
      composeMessage({
        from,
        to: [{ name: null, address: 'not-an-address' }],
        cc: [],
        bcc: [],
        subject: 'Hello',
        text: 'x'
      })
    ).toThrow('usable email address');
    expect(() =>
      composeMessage({ from, to: [], cc: [], bcc: [], subject: 'Hello', text: 'x' })
    ).toThrow('at least one recipient');
  });
});
