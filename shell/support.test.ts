import { expect, test } from 'bun:test';
import { describeBalance, formatPrice, parseBalance } from './support';

test("parseBalance reads the balance, the monthly price and the time of `balance.json`'s text", () => {
    const text = JSON.stringify({ balance: '12.50', price: '9.00', asOf: '2026-11-19T08:00+00:00' });

    expect(parseBalance(text)).toEqual({ balance: 12.5, price: 9, asOf: new Date('2026-11-19T08:00Z') });
});

test('parseBalance returns `undefined` for a broken `balance.json`', () => {
    const texts = [
        '',
        '{"balance": "12.50"',
        'null',
        '[]',
        JSON.stringify({ price: '9.00', asOf: '2026-11-19T08:00+00:00' }),
        JSON.stringify({ balance: '12,50', price: '9.00', asOf: '2026-11-19T08:00+00:00' }),
        JSON.stringify({ balance: '12.50', price: '0.00', asOf: '2026-11-19T08:00+00:00' }),
        JSON.stringify({ balance: '12.50', price: '9.00', asOf: 'yesterday' }),
        JSON.stringify({ balance: '99999999999999999', price: '9.00', asOf: '2026-11-19T08:00+00:00' }),
    ];

    expect(texts.map(parseBalance)).toEqual(texts.map(() => undefined));
});

test("parseBalance returns `undefined` for a balance, a price or a time that isn't text", () => {
    const texts = [
        JSON.stringify({ balance: [12], price: '9.00', asOf: '2026-11-19T08:00+00:00' }),
        JSON.stringify({ balance: 12.5, price: '9.00', asOf: '2026-11-19T08:00+00:00' }),
        JSON.stringify({ balance: '12.50', price: 9, asOf: '2026-11-19T08:00+00:00' }),
        JSON.stringify({ balance: '12.50', price: '9.00', asOf: 2026 }),
    ];

    expect(texts.map(parseBalance)).toEqual(texts.map(() => undefined));
});

test('describeBalance writes the balance with a decimal point, the last day that the balance pays for and the balance date', () => {
    const status = describeBalance({ balance: 12.5, price: 9, asOf: new Date('2026-11-19T08:00Z') });

    expect(status).toEqual({
        amount: '€12.50',
        lastDay: 'paid until 2026-12-31',
        months: '1.4 of 12 months covered',
        asOf: 'as of 2026-11-19',
        share: 12.5 / 108,
    });
});

test('describeBalance writes the date of the balance as the last day for an empty balance', () => {
    const status = describeBalance({ balance: 0, price: 9, asOf: new Date('2026-11-19T08:00Z') });

    expect([status.amount, status.lastDay, status.months, status.share]).toEqual(['€0.00', 'paid until 2026-11-19', '0 of 12 months covered', 0]);
});

test('describeBalance writes a negative balance as it is and covers no months with it', () => {
    const status = describeBalance({ balance: -5, price: 9, asOf: new Date('2026-11-19T08:00Z') });

    expect(status).toEqual({
        amount: '-€5.00',
        lastDay: 'paid until 2026-11-19',
        months: '0 of 12 months covered',
        asOf: 'as of 2026-11-19',
        share: 0,
    });
});

test("describeBalance writes the dates in Berlin's time zone", () => {
    const status = describeBalance({ balance: 0, price: 9, asOf: new Date('2026-11-20T00:30+01:00') });

    expect([status.lastDay, status.asOf]).toEqual(['paid until 2026-11-20', 'as of 2026-11-20']);
});

test('describeBalance fills the share up to the whole year for a balance that covers more than 12 months', () => {
    const status = describeBalance({ balance: 200, price: 9, asOf: new Date('2026-11-19T08:00Z') });

    expect([status.months, status.share]).toEqual(['22.2 of 12 months covered', 1]);
});

test('formatPrice leaves out the cents of a whole price', () => {
    expect([9, 10.5, 1200].map(formatPrice)).toEqual(['€9', '€10.50', '€1,200']);
});

test('formatPrice rounds a price to whole cents', () => {
    expect(formatPrice(9.999)).toBe('€10');
});
