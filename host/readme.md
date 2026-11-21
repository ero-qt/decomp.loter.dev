# Hosting

The site runs on Uberspace 8. Apache serves it from `/var/www/virtual/decomp/html`.

## Deploy

- A version tag starts the deploy in GitHub Actions. It waits until I approve it.
- Each version gets its own folder in `releases`. `html` links to the live one.
- `receive-deploy.sh` checks a new version, then switches the link. The last 3 versions stay on the host.
- The deploy key can only upload and switch. It can't run commands or read files.

## Files

- `htaccess` sends the site's headers, serves `.wasm` files right and turns PHP off.
- `update-balance.sh` updates `balance.json` once a day for the Support tab.

The balance comes from an Uberspace dashboard address that isn't an official API. If Uberspace turns it off, the Support tab keeps showing the last balance.
