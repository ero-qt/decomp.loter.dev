import { registration } from './registration';

// awaits the API in its own module because `registration.ts` loads before the workbench starts and the API resolves
// after the start
/** The VS Code API of the site's extension. */
export const vscode = await registration.getApi();
