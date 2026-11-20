import { expect, test } from 'bun:test';
import { drawTransferCode, formatTransferCode } from './transfer-code';

test('formatTransferCode writes an EPC QR code text for a SEPA transfer to Uberspace without an amount and with the reference', () => {
    expect(formatTransferCode()).toBe([
        'BCD',
        '002',
        '1',
        'SCT',
        'MALADE51WOR',
        'Jonas Pasche',
        'DE09553500100200003978',
        '',
        '',
        '',
        'Uberspace decomp',
    ].join('\n'));
});

test(
    "drawTransferCode draws 41 modules across, version 5's 37 and a quiet zone of 2 on each side, for 2 pixels per module in the 82 pixel image",
    async () => {
        const svg = drawTransferCode();
        const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg) ?? [];
        const [, moduleSize] = /<path[^>]* d="M\d+,\d+h(\d+)v\1h-\1z/.exec(svg) ?? [];
        const html = await Bun.file(new URL('index.html', import.meta.url)).text();
        const [, imageWidth, imageHeight] = /<img alt="Bank transfer QR code" width="(\d+)" height="(\d+)">/.exec(html) ?? [];

        expect([Number(width) / Number(moduleSize), Number(height) / Number(moduleSize)]).toEqual([41, 41]);
        expect([Number(imageWidth) / 41, Number(imageHeight) / 41]).toEqual([2, 2]);
    },
);
