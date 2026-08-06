import { describe, expect, it } from 'vitest';
import {
  discoverCalendars,
  parseXml,
  readEventRange,
  resolveHref,
  writeEvent,
  type CalDavContext
} from './caldav.js';
import type { ConnectorRequestInput, ConnectorRequestResult } from './connectors.js';

const xml = (body: string): ConnectorRequestResult => ({
  status: 207,
  headers: { 'content-type': 'application/xml' },
  body: Buffer.from(body, 'utf8'),
  durationMs: 3
});

const context = (
  handler: (input: ConnectorRequestInput) => ConnectorRequestResult,
  calls: ConnectorRequestInput[] = []
): CalDavContext & { calls: ConnectorRequestInput[] } => ({
  baseUrl: new URL('https://cloud.example.test/remote.php/dav/'),
  headers: { authorization: 'Basic secret' },
  allowedHostSuffixes: ['cloud.example.test'],
  transport: async (input) => {
    calls.push(input);
    return handler(input);
  },
  calls
});

const principalResponse = xml(
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/owner/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`
);

const homeResponse = xml(
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/principals/owner/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/remote.php/dav/calendars/owner/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>`
);

const calendarsResponse = xml(
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
    <d:response><d:href>/remote.php/dav/calendars/owner/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/calendars/owner/personal/</d:href><d:propstat><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Personal &amp; family</d:displayname>
      <d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set>
    </d:prop></d:propstat></d:response>
    <d:response><d:href>/remote.php/dav/calendars/owner/shared/</d:href><d:propstat><d:prop>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <d:displayname>Shared</d:displayname>
      <d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>
    </d:prop></d:propstat></d:response>
  </d:multistatus>`
);

describe('caldav xml', () => {
  it('reads namespaced elements, entities and CDATA without an XML dependency', () => {
    const document = parseXml(
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><!-- note --><D:href>/a &amp; b</D:href><C:calendar-data><![CDATA[BEGIN:VCALENDAR]]></C:calendar-data><D:empty/></D:multistatus>'
    );
    expect(document.children[0]?.name).toBe('multistatus');
    expect(document.children[0]?.children.map((child) => child.name)).toEqual([
      'href',
      'calendar-data',
      'empty'
    ]);
    expect(document.children[0]?.children[0]?.text).toBe('/a & b');
    expect(document.children[0]?.children[1]?.text).toBe('BEGIN:VCALENDAR');
  });
});

describe('caldav discovery', () => {
  it('walks principal to home to calendars and reports what is writable', async () => {
    const responses = [principalResponse, homeResponse, calendarsResponse];
    const calls: ConnectorRequestInput[] = [];
    const calendars = await discoverCalendars(context(() => responses.shift()!, calls));
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'PROPFIND /remote.php/dav/',
      'PROPFIND /remote.php/dav/principals/owner/',
      'PROPFIND /remote.php/dav/calendars/owner/'
    ]);
    expect(calendars).toEqual([
      {
        url: 'https://cloud.example.test/remote.php/dav/calendars/owner/personal/',
        name: 'Personal & family',
        description: null,
        color: null,
        readOnly: false
      },
      {
        url: 'https://cloud.example.test/remote.php/dav/calendars/owner/shared/',
        name: 'Shared',
        description: null,
        color: null,
        readOnly: true
      }
    ]);
  });

  it('falls back to the pasted URL when the server does not answer a principal lookup', async () => {
    let call = 0;
    const calendars = await discoverCalendars(
      context(() => {
        call += 1;
        if (call === 1) return { ...xml('nope'), status: 404 };
        return calendarsResponse;
      })
    );
    expect(calendars).toHaveLength(2);
  });

  it('refuses an href that points off the connector origin', () => {
    expect(() =>
      resolveHref(
        context(() => xml('')),
        'https://evil.test/steal'
      )
    ).toThrow('different host');
    expect(
      resolveHref(
        context(() => xml('')),
        '/remote.php/dav/x/'
      ).toString()
    ).toBe('https://cloud.example.test/remote.php/dav/x/');
  });
});

describe('caldav reading and writing', () => {
  const event = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:e1@example.test',
    'SUMMARY:Standup',
    'DTSTART:20260714T090000Z',
    'DTEND:20260714T091500Z',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const rangeResponse = xml(
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/owner/personal/e1.ics</d:href><d:propstat><d:prop><d:getetag>"abc"</d:getetag><c:calendar-data>${event}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`
  );

  it('asks the server to expand repeats and retries without it when refused', async () => {
    const bodies: string[] = [];
    let call = 0;
    const range = await readEventRange(
      context((input) => {
        bodies.push(Buffer.from(input.body ?? []).toString('utf8'));
        call += 1;
        if (call === 1) return { ...xml('unsupported'), status: 400 };
        return rangeResponse;
      }),
      new URL('https://cloud.example.test/remote.php/dav/calendars/owner/personal/'),
      '2026-07-13T00:00:00Z',
      '2026-07-20T00:00:00Z',
      50
    );
    expect(bodies[0]).toContain('<c:expand start="20260713T000000Z" end="20260720T000000Z"/>');
    expect(bodies[1]).not.toContain('c:expand');
    expect(range.expanded).toBe(false);
    expect(range.objects[0]?.etag).toBe('"abc"');
    expect(range.objects[0]?.calendarData).toContain('UID:e1@example.test');
  });

  it('guards a create with If-None-Match and an update with If-Match', async () => {
    const seen: ConnectorRequestInput[] = [];
    const target = context(
      () => ({
        status: 201,
        headers: { etag: 'W/"new"' },
        body: Buffer.alloc(0),
        durationMs: 1
      }),
      seen
    );
    const created = await writeEvent(
      target,
      new URL('https://cloud.example.test/remote.php/dav/calendars/owner/personal/e2.ics'),
      event,
      { create: true }
    );
    expect(seen[0]?.headers['if-none-match']).toBe('*');
    expect(created.etag).toBe('"new"');
    await writeEvent(
      target,
      new URL('https://cloud.example.test/remote.php/dav/calendars/owner/personal/e2.ics'),
      event,
      { ifMatch: '"abc"' }
    );
    expect(seen[1]?.headers['if-match']).toBe('"abc"');
    expect(seen[1]?.headers['if-none-match']).toBeUndefined();
  });
});
