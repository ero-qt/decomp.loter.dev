import { renderSVG } from 'uqr';

/** The bank details of the support note's transfer to Uberspace. */
export const transfer = {
    name: 'Jonas Pasche',
    iban: 'DE09 5535 0010 0200 0039 78',
    bic: 'MALADE51WOR',
    reference: 'Uberspace decomp',
};

/**
 * Writes the transfer as the text of an EPC QR code ("GiroCode", EPC069-12 version 002) in UTF-8, without an amount and
 * with the reference as the unstructured remittance information.
 */
export function formatTransferCode(): string {
    const { name, iban, bic, reference } = transfer;

    return ['BCD', '002', '1', 'SCT', bic, name, iban.replaceAll(' ', ''), '', '', '', reference].join('\n');
}

/** Draws the transfer's EPC QR code as an SVG with the error correction level M and a white quiet zone of 2 modules. */
export function drawTransferCode(): string {
    return renderSVG(formatTransferCode(), { ecc: 'M', border: 2 });
}
