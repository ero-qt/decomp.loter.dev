/** The balance of the site's server, the server's monthly price in euros and the time of the balance. */
export interface Balance {
    balance: number;
    price: number;
    asOf: Date;
}

// counts a month as the average calendar month's days because a balance can last across months of different lengths
const monthDays = 365.25 / 12;
const dayMilliseconds = 24 * 60 * 60 * 1000;
const goalMonths = 12;
const euros = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
const prices = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', trailingZeroDisplay: 'stripIfInteger' });
const monthCounts = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
// writes dates in Berlin's time zone because the host and the note's readers are in Germany
const dates = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });

function isAmount(value: unknown): value is string {
    return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
}

function countCoveredMonths({ balance, price }: Balance): number {
    return Math.max(balance / price, 0);
}

function findLastDay(balance: Balance): Date {
    return new Date(balance.asOf.getTime() + Math.floor(countCoveredMonths(balance) * monthDays) * dayMilliseconds);
}

/**
 * Reads the balance from the text of `balance.json`, which the host writes into the site's folder. Returns `undefined`
 * for a broken file.
 */
export function parseBalance(text: string): Balance | undefined {
    let file: Partial<Record<keyof Balance, unknown>> | null;
    try {
        file = JSON.parse(text);
    } catch {
        return undefined;
    }

    const { balance, price, asOf } = file ?? {};
    if (!isAmount(balance) || !isAmount(price) || typeof asOf !== 'string') {
        return undefined;
    }

    const parsed = { balance: Number(balance), price: Number(price), asOf: new Date(asOf) };
    // rejects a balance whose last day lies past the last valid date because the note couldn't write that day
    if (parsed.price <= 0 || isNaN(parsed.asOf.getTime()) || isNaN(findLastDay(parsed).getTime())) {
        return undefined;
    }

    return parsed;
}

/** The texts of the note's balance status and the share of the year's goal that the balance covers. */
export interface BalanceStatus {
    amount: string;
    lastDay: string;
    months: string;
    asOf: string;
    share: number;
}

/**
 * Describes the balance, the last day that the balance pays for and the months that the balance covers out of a year.
 */
export function describeBalance(balance: Balance): BalanceStatus {
    const covered = countCoveredMonths(balance);

    return {
        amount: euros.format(balance.balance),
        lastDay: `paid until ${dates.format(findLastDay(balance))}`,
        months: `${monthCounts.format(covered)} of ${goalMonths} months covered`,
        asOf: `as of ${dates.format(balance.asOf)}`,
        share: Math.min(covered / goalMonths, 1),
    };
}

/** Writes a price in euros in English form and without the cents of a whole price. */
export function formatPrice(price: number): string {
    return prices.format(price);
}

// reads `balance.json` as text, or an empty text without the file, because the host writes the file only on the site's
// server
async function fetchBalanceFile(): Promise<string> {
    try {
        const response = await fetch('balance.json');

        return response.ok ? await response.text() : '';
    } catch {
        return '';
    }
}

let balanceFile: Promise<string> | undefined;

// fetches `balance.json` once because each About pane fills its own copy of the note
function readBalanceFile(): Promise<string> {
    balanceFile ??= fetchBalanceFile();

    return balanceFile;
}

function showBalanceStatus(element: HTMLElement, status: BalanceStatus) {
    for (const key of ['amount', 'lastDay', 'months', 'asOf'] as const) {
        element.querySelector(`[data-status="${key}"]`)!.textContent = status[key];
    }

    const bar = element.querySelector<HTMLElement>('.status-bar')!;
    bar.setAttribute('aria-valuenow', String(status.share * goalMonths));
    bar.setAttribute('aria-valuetext', status.months);
    bar.querySelector<HTMLElement>('div')!.style.width = `${status.share * 100}%`;
    element.hidden = false;
}

/**
 * Shows the QR code at the URL in the support note and fills in the monthly price and the balance status from
 * `balance.json`.
 */
export async function fillSupportNote(note: HTMLElement, codeUrl: string) {
    note.querySelector('img')!.src = codeUrl;
    const balance = parseBalance(await readBalanceFile());
    if (balance) {
        note.querySelector('.support-price')!.textContent = formatPrice(balance.price);
        showBalanceStatus(note.querySelector<HTMLElement>('.support-status')!, describeBalance(balance));
    }
}
