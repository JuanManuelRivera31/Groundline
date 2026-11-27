import { describe, expect, it } from 'vitest';
import { REDACTED, redactPii } from '../src/privacy/redact.ts';

const r = (text: string): string => redactPii(text).text;

describe('redactPii: English', () => {
  it('redacts email addresses', () => {
    expect(r('My email is john.doe+plausible@example.co.uk, please reply.')).toBe(`My email is ${REDACTED}, please reply.`);
    expect(redactPii('a@b.io and c.d@e-f.com').counts.email).toBe(2);
  });

  it('redacts phone numbers in common formats', () => {
    expect(r('Call me at +1 (555) 123-4567 tomorrow')).toBe(`Call me at ${REDACTED} tomorrow`);
    expect(r('my number is 555-123-4567.')).toBe(`my number is ${REDACTED}.`);
    expect(r('UK: +44 20 7946 0958')).toBe(`UK: ${REDACTED}`);
    expect(r('phone 555.123.4567')).toBe(`phone ${REDACTED}`);
  });

  it('redacts card-shaped numbers', () => {
    expect(r('card 4111 1111 1111 1111 was charged twice')).toBe(`card ${REDACTED} was charged twice`);
    expect(r('card 4111-1111-1111-1111')).toBe(`card ${REDACTED}`);
    expect(r('amex 378282246310005')).toBe(`amex ${REDACTED}`);
    expect(redactPii('4111111111111111').counts.card).toBe(1);
  });

  it('redacts IPv4 and IPv6 addresses', () => {
    expect(r('my server IP is 203.0.113.42, blocked?')).toBe(`my server IP is ${REDACTED}, blocked?`);
    expect(r('exclude 2001:db8:85a3::8a2e:370:7334 please')).toBe(`exclude ${REDACTED} please`);
    expect(r('full 2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(`full ${REDACTED}`);
    expect(r('localhost ::1 only')).toBe(`localhost ${REDACTED} only`);
  });

  it('keeps dates, versions, ports, amounts, times and code', () => {
    const keep = [
      'Since 2024-05-12 my stats are gone',
      'I upgraded to version 2.3.1 and v10.0.4',
      'running on port 8080 and 54329',
      'we had 100,000 pageviews and 1,250,000 events',
      'the meeting is at 10:30:00',
      'std::vector is not related',
      'set data-domain="example.com" in the script',
      'error 404 after 30 seconds',
      'a 12.5% bounce rate on 31/12/2024',
    ];
    for (const text of keep) expect(r(text), text).toBe(text);
  });

  it('does not touch numeric URL segments but still redacts emails in URLs', () => {
    expect(r('see https://plausible.io/sites/123456789012/settings?id=4111111111111111 ok')).toBe(
      'see https://plausible.io/sites/123456789012/settings?id=4111111111111111 ok',
    );
    expect(r('https://x.example/u?email=jane@example.com')).toBe(`https://x.example/u?email=${REDACTED}`);
    expect(r('http://192.168.1.10/admin')).toBe(`http://${REDACTED}/admin`);
  });

  it('counts every kind and reports the total', () => {
    const result = redactPii('jane@example.com, +1 555 123 4567, 4111 1111 1111 1111, 10.0.0.1');
    expect(result.counts).toEqual({ email: 1, ip: 1, card: 1, phone: 1 });
    expect(result.total).toBe(4);
    expect(result.text).toBe([REDACTED, REDACTED, REDACTED, REDACTED].join(', '));
  });
});

describe('redactPii: Spanish', () => {
  it('redacts emails and Spanish phone formats', () => {
    expect(r('Mi correo es juan.perez@ejemplo.es y no me llega nada')).toBe(`Mi correo es ${REDACTED} y no me llega nada`);
    expect(r('Llámame al +34 612 34 56 78 por favor')).toBe(`Llámame al ${REDACTED} por favor`);
    expect(r('mi móvil: 612345678')).toBe(`mi móvil: ${REDACTED}`);
    expect(r('teléfono 91 123 45 67')).toBe(`teléfono ${REDACTED}`);
    expect(r('México: +52 55 1234 5678')).toBe(`México: ${REDACTED}`);
  });

  it('redacts cards and IPs in Spanish sentences', () => {
    expect(r('Me cobraron dos veces en la tarjeta 5500 0000 0000 0004.')).toBe(`Me cobraron dos veces en la tarjeta ${REDACTED}.`);
    expect(r('¿Cómo excluyo mi IP 81.45.120.7 de las estadísticas?')).toBe(`¿Cómo excluyo mi IP ${REDACTED} de las estadísticas?`);
  });

  it('keeps Spanish dates, amounts and versions', () => {
    const keep = ['Desde el 12.05.2024 no veo visitas', 'Tengo 1.250.000 visitas al mes', 'uso la versión 2.1.0', 'pagué 9,00 € el 31/12/2024'];
    for (const text of keep) expect(r(text), text).toBe(text);
  });
});
