#!/usr/bin/env bash
# Writes the Asteroid's balance and monthly price to balance.json in the site's folder, for the support note.
# Usage: update-balance.sh <cookie file> <site folder>
# The cookie file has a logged-in dashboard session's cookies, copied from the browser, on one line: either the
# bare value, like `sessionid=abc`, or the whole header, like `Cookie: sessionid=abc`.
set -euo pipefail

cookie_file=$1
site=$2
url='https://dashboard.uberspace.de/dashboard/accountinfo?format=json&asteroid=decomp'

cookie=$(tr -d '\r' < "$cookie_file")
# refuses a second line because curl would read it as another setting in its config
if [[ $cookie == *$'\n'* ]]; then
    echo 'The cookie file has more than one line.' >&2
    exit 1
fi

cookie=$(printf '%s' "$cookie" | sed 's/^[[:space:]]*\([Cc][Oo][Oo][Kk][Ii][Ee]:\)\{0,1\}[[:space:]]*//; s/[[:space:]]*$//')
cookie=${cookie//\\/\\\\}
cookie=${cookie//\"/\\\"}

# hands curl the cookie in a config on stdin because its arguments show in the process list
json=$(printf 'header = "Cookie: %s"\n' "$cookie" | curl -fsS --max-time 30 -K - "$url")

# makes the temp file after the request, so a switch of the site's link during the request doesn't leave a file in
# the old release
new=$(mktemp "$site/balance.json.XXXXXX")
trap 'rm -f "$new"' EXIT
python3 -c '
import datetime, json, re, sys

# reads numbers as their text so that 12.50 stays "12.50"
info = json.load(sys.stdin, parse_float=str, parse_int=str)

def amount(key):
    value = info.get(key)
    if not isinstance(value, str) or not re.fullmatch(r"-?\d+(\.\d+)?", value):
        sys.exit(f"{key} in the account info is {value!r}, not an amount")
    return value

print(json.dumps({
    "balance": amount("current_amount"),
    "price": amount("price"),
    "asOf": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
}))
' <<< "$json" > "$new"
chmod 644 "$new"
mv "$new" "$site/balance.json"
